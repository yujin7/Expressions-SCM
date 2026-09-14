import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { createStockRequest, getStockCreateResult, cancelStockCreateRequest } from "@/server/modules/inventory/stock-create-request";
import { POST as CANCEL } from "@/app/api/inventory/stock-doc/cancel-create/route";
import { POST } from "@/app/api/inventory/stock-doc/route";
import { GET } from "@/app/api/inventory/stock-doc/create-result/route";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, close: () => Promise<void>, actor: SessionUser, peer: SessionUser, skuId: number, warehouseId: number;
let token: SessionUser | null;
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
vi.mock("@/server/auth", () => ({ auth: async () => token ? { user: { ...token, id: String(token.id) } } : null }));
beforeAll(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close();
  const people = await db.insert(s.users).values([{ name: "恢复仓管", roles: ["warehouse"] }, { name: "另一仓管", roles: ["warehouse"] }]).returning();
  [actor, peer] = people.map(p => ({ id: p.id, name: p.name, roles: p.roles, isApprover: p.isApprover, sessionVersion: p.sessionVersion }));
  const [spu] = await db.insert(s.spus).values({ code: "STOCK-RECEIPT", nameCn: "库存恢复" }).returning();
  const [sku] = await db.insert(s.skus).values({ spuId: spu.id, code: "STOCK-RECEIPT", name: "库存恢复", skuType: "raw", baseUom: "kg" }).returning(); skuId = sku.id;
  const [wh] = await db.insert(s.warehouses).values({ code: "STOCK-RECEIPT", name: "库存恢复", kind: "raw", accountingMode: "realtime" }).returning(); warehouseId = wh.id;
});
afterAll(async () => close());
afterEach(async () => {
  vi.restoreAllMocks(); token = null;
  await db.update(s.users).set({ active: true, roles: actor.roles, sessionVersion: actor.sessionVersion }).where(eq(s.users.id, actor.id));
  await db.update(s.warehouses).set({ active: true }).where(eq(s.warehouses.id, warehouseId));
});
const input = () => ({ requestKey: randomUUID(), subtype: "opening", warehouseId, lines: [{ skuId, qty: "0.0001", price: "1.23" }] });
const snapshot = async () => ({
  docs: await db.select().from(s.stockDocs).orderBy(s.stockDocs.id), lines: await db.select().from(s.stockDocLines).orderBy(s.stockDocLines.id),
  receipt: await db.select().from(s.stockCreateRequests).orderBy(s.stockCreateRequests.id), audits: await db.select().from(s.auditLogs).orderBy(s.auditLogs.id),
  counters: await db.select().from(s.docCounters), ledger: await db.select().from(s.stockLedger),
});
it("same account/key and normalized intent replays exactly once without posting", async () => {
  const body = input(), before = await snapshot(), first = await createStockRequest(actor, body, db);
  expect(await createStockRequest(actor, { ...body, requestKey: body.requestKey.toUpperCase(), lines: [{ skuId, qty: "0.00010", price: "1.230" }] }, db)).toEqual(first);
  const after = await snapshot();
  for (const key of ["docs", "lines", "receipt", "audits"] as const) expect(after[key].length).toBe(before[key].length + 1);
  expect(after.ledger).toEqual(before.ledger);
  const legacyHash = createHash("sha256").update(JSON.stringify({ subtype: "opening", warehouseId, toWarehouseId: null,
    transferType: null, reason: null, remark: null, riskDisposalId: null,
    lines: [{ skuId, qty: "0.0001", price: "1.23", batchId: null }] })).digest("hex");
  expect(after.receipt.at(-1)?.requestHash).toBe(legacyHash);
});
it.each(["quantity", "price", "remark", "batch", "line-count"])("same key with changed %s conflicts without another write", async field => {
  const body = input(); await createStockRequest(actor, body, db); const before = await snapshot();
  const changed = field === "remark" ? { ...body, remark: "different" } : { ...body, lines: field === "line-count" ? [...body.lines, ...body.lines]
    : [{ ...body.lines[0], ...(field === "quantity" ? { qty: "1" } : field === "price" ? { price: "2" } : { batchId: 123 }) }] };
  await expect(createStockRequest(actor, changed, db)).rejects.toMatchObject({ status: 409 }); expect(await snapshot()).toEqual(before);
});
it("read-only lookup returns current status, not a fabricated fresh draft, and can recover after source disable", async () => {
  const body = input(), first = await createStockRequest(actor, body, db);
  await db.update(s.stockDocs).set({ status: "void" }).where(eq(s.stockDocs.id, first.document.id));
  await db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, warehouseId));
  const before = await snapshot();
  expect((await getStockCreateResult(actor, body.requestKey, db)).document?.status).toBe("void");
  expect((await createStockRequest(actor, body, db)).document.status).toBe("void"); expect(await snapshot()).toEqual(before);
});
it("actor-scoped receipts cannot reveal peers and separate intentional requests remain separate", async () => {
  const body = input(), first = await createStockRequest(actor, body, db);
  expect((await getStockCreateResult(peer, body.requestKey, db)).document).toBeNull();
  expect((await createStockRequest(peer, body, db)).document.id).not.toBe(first.document.id);
  expect((await createStockRequest(actor, { ...body, requestKey: randomUUID() }, db)).document.id).not.toBe(first.document.id);
});
it.each(["disabled", "role", "session"])("%s cannot retrieve or replay an existing receipt", async reason => {
  const body = input(); await createStockRequest(actor, body, db);
  await db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "role" ? { roles: ["ops"] } : { sessionVersion: actor.sessionVersion! + 1 }).where(eq(s.users.id, actor.id));
  const before = await snapshot();
  await expect(getStockCreateResult(actor, body.requestKey, db)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
  await expect(createStockRequest(actor, body, db)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 }); expect(await snapshot()).toEqual(before);
});
it("a rejected new request can be corrected using the same key", async () => {
  const body = input(); await db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, warehouseId)); const before = await snapshot();
  await expect(createStockRequest(actor, body, db)).rejects.toMatchObject({ status: 400 }); expect(await snapshot()).toEqual(before);
  expect((await getStockCreateResult(actor, body.requestKey, db)).document).toBeNull();
  await db.update(s.warehouses).set({ active: true }).where(eq(s.warehouses.id, warehouseId));
  expect((await createStockRequest(actor, body, db)).document.status).toBe("draft");
});
it("audit failure rolls back receipt, number, document and lines before checked retry", async () => {
  const body = input(), before = await snapshot(); vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("stock receipt audit fault"));
  await expect(createStockRequest(actor, body, db)).rejects.toThrow("stock receipt audit fault"); expect(await snapshot()).toEqual(before);
  expect((await createStockRequest(actor, body, db)).document.status).toBe("draft");
});
it("receipt insertion failure also rolls back the nested document/audit transaction", async () => {
  const body = input(), before = await snapshot(), transaction = db.transaction.bind(db);
  vi.spyOn(db, "transaction").mockImplementationOnce(callback => transaction(tx => callback(new Proxy(tx, { get(target, property, receiver) {
    if (property === "insert") return (table: unknown) => { if (table === s.stockCreateRequests) throw Error("receipt insert fault"); return target.insert(table as typeof s.stockCreateRequests); };
    return Reflect.get(target, property, receiver);
  } }))));
  await expect(createStockRequest(actor, body, db)).rejects.toThrow("receipt insert fault"); expect(await snapshot()).toEqual(before);
});
it("database enforces immutable and unique receipts", async () => {
  const body = input(); await createStockRequest(actor, body, db);
  const [r] = await db.select().from(s.stockCreateRequests);
  await expect(db.update(s.stockCreateRequests).set({ requestHash: "a".repeat(64) }).where(eq(s.stockCreateRequests.id, r.id))).rejects.toThrow();
  await expect(db.delete(s.stockCreateRequests).where(eq(s.stockCreateRequests.id, r.id))).rejects.toThrow();
  await expect(db.execute(sql`TRUNCATE stock_create_requests`)).rejects.toThrow();
  await expect(db.insert(s.stockCreateRequests).values({ requestedBy: r.requestedBy, requestKey: r.requestKey, stockDocId: r.stockDocId, requestHash: r.requestHash })).rejects.toThrow();
});
it("HTTP requires a key and lookup rejects ambiguous parameters, returns no-store and current account only", async () => {
  token = actor; const body = input();
  const post = (v: unknown) => POST(new NextRequest("http://localhost/api/inventory/stock-doc", { method: "POST", headers: { "x-scm-stock-create-contract": "2" }, body: JSON.stringify(v) }));
  expect((await post({ ...body, requestKey: undefined })).status).toBe(400);
  expect((await post(body)).status).toBe(201);
  const get = (q: string) => GET(new NextRequest(`http://localhost/api/inventory/stock-doc/create-result?${q}`));
  const r = await get(`requestKey=${body.requestKey}`); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store");
  for (const q of ["", "requestKey=no", `requestKey=${body.requestKey}&requestKey=${body.requestKey}`, `requestKey=${body.requestKey}&actorId=1`]) expect((await get(q)).status).toBe(400);
  token = peer; expect((await (await get(`requestKey=${body.requestKey}`)).json()).document).toBeNull();
  token = null; expect((await get(`requestKey=${body.requestKey}`)).status).toBe(401);
});

it("a stale browser cannot silently strip replacement context and create an unrelated draft", async () => {
  token = actor; const before = await snapshot();
  for (const version of [undefined, "1", "3"]) {
    const result = await POST(new NextRequest("http://localhost/api/inventory/stock-doc", { method: "POST",
      headers: version ? { "x-scm-stock-create-contract": version } : {}, body: JSON.stringify(input()) }));
    expect(result.status).toBe(400); expect((await result.json()).error).toContain("页面版本已更新");
  }
  expect(await snapshot()).toEqual(before);
});

it("cancellation permanently fences the account/key without needing valid sources or creating stock", async () => {
  const body = input(), before = await snapshot();
  await db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, warehouseId));
  const result = await cancelStockCreateRequest(actor, { requestKey: body.requestKey.toUpperCase() }, db);
  expect(result).toEqual({ requestKey: body.requestKey, document: null, cancelled: true });
  const after = await snapshot();
  for (const key of ["docs", "lines", "counters", "ledger"] as const) expect(after[key]).toEqual(before[key]);
  expect(after.receipt).toHaveLength(before.receipt.length + 1); expect(after.audits).toHaveLength(before.audits.length + 1);
  expect(after.receipt.at(-1)).toMatchObject({ cancelled: true, requestHash: null, stockDocId: null });
  expect(after.audits.at(-1)).toMatchObject({ userId: actor.id, entity: "stock_create_request", action: "cancel", after: { requestKey: body.requestKey, cancelled: true, documentId: null } });
  expect(await cancelStockCreateRequest(actor, { requestKey: body.requestKey }, db)).toEqual(result);
  expect(await getStockCreateResult(actor, body.requestKey, db)).toEqual(result);
  await expect(createStockRequest(actor, body, db)).rejects.toMatchObject({ status: 409 });
  await expect(createStockRequest(actor, { ...body, remark: "changed" }, db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(after);
});
it.each(["draft", "void", "completed"])("creation already won: cancellation preserves the original %s document", async status => {
  const body = input(), first = await createStockRequest(actor, body, db);
  await db.update(s.stockDocs).set({ status: status as "draft" | "void" | "completed" }).where(eq(s.stockDocs.id, first.document.id));
  const before = await snapshot();
  expect(await cancelStockCreateRequest(actor, { requestKey: body.requestKey }, db)).toMatchObject({ document: { id: first.document.id, status } });
  expect(await snapshot()).toEqual(before);
});
it("cancellation audit fault rolls back its terminal result; later creation remains possible", async () => {
  const body = input(), before = await snapshot(); vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("cancel audit fault"));
  await expect(cancelStockCreateRequest(actor, { requestKey: body.requestKey }, db)).rejects.toThrow("cancel audit fault");
  expect(await snapshot()).toEqual(before); expect(await getStockCreateResult(actor, body.requestKey, db)).toEqual({ requestKey: body.requestKey, document: null });
  expect((await createStockRequest(actor, body, db)).document.status).toBe("draft");
});
it("same key in another account never cancels this actor's request", async () => {
  const body = input(); await cancelStockCreateRequest(peer, { requestKey: body.requestKey }, db);
  expect(await getStockCreateResult(actor, body.requestKey, db)).toEqual({ requestKey: body.requestKey, document: null });
  expect((await createStockRequest(actor, body, db)).document.status).toBe("draft");
});
it.each(["disabled", "role", "session"])("%s cannot cancel even an existing cancellation", async reason => {
  const body = input(); await cancelStockCreateRequest(actor, { requestKey: body.requestKey }, db);
  await db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "role" ? { roles: ["ops"] } : { sessionVersion: actor.sessionVersion! + 1 }).where(eq(s.users.id, actor.id));
  const before = await snapshot();
  for (const key of [body.requestKey, randomUUID()]) await expect(cancelStockCreateRequest(actor, { requestKey: key }, db)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
  expect(await snapshot()).toEqual(before);
});
it("database enforces exclusive created/cancelled outcomes and immutable cancellations", async () => {
  const body = input(); await cancelStockCreateRequest(actor, { requestKey: body.requestKey }, db);
  const [r] = await db.select().from(s.stockCreateRequests).where(eq(s.stockCreateRequests.requestKey, body.requestKey));
  await expect(db.update(s.stockCreateRequests).set({ cancelled: false }).where(eq(s.stockCreateRequests.id, r.id))).rejects.toThrow();
  await expect(db.delete(s.stockCreateRequests).where(eq(s.stockCreateRequests.id, r.id))).rejects.toThrow();
  for (const invalid of [{}, { cancelled: true, requestHash: "a".repeat(64) }, { cancelled: false, requestHash: "a".repeat(64) }])
    await expect(db.insert(s.stockCreateRequests).values({ requestedBy: actor.id, requestKey: randomUUID(), ...invalid })).rejects.toThrow();
});
it("cancellation HTTP authenticates before parsing, rejects forged actor and returns no-store", async () => {
  const post = (body: unknown) => CANCEL(new NextRequest("http://localhost/api/inventory/stock-doc/cancel-create", { method: "POST", body: JSON.stringify(body) }));
  expect((await post({})).status).toBe(401); token = actor;
  const body = { requestKey: randomUUID() }; expect((await post({ ...body, actorId: peer.id })).status).toBe(400);
  const r = await post(body); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await r.json()).toEqual({ ...body, document: null, cancelled: true });
});
