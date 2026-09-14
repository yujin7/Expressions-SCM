import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { createCtRequest, getCtCreateResult, cancelCtCreateRequest } from "@/server/modules/matflow/ct-create-request";
import { POST } from "@/app/api/matflow/ct/route";
import { GET } from "@/app/api/matflow/ct/create-result/route";
import { POST as CANCEL } from "@/app/api/matflow/ct/cancel-create/route";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, close: () => Promise<void>, actor: SessionUser, peer: SessionUser, skuId: number, warehouseId: number;
let poId: number, poLineId: number;
let token: SessionUser | null;
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
vi.mock("@/server/auth", () => ({ auth: async () => token ? { user: { ...token, id: String(token.id) } } : null }));
beforeAll(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close();
  const people = await db.insert(s.users).values([{ name: "恢复仓管", roles: ["warehouse"] }, { name: "另一仓管", roles: ["warehouse"] }]).returning();
  [actor, peer] = people.map(p => ({ id: p.id, name: p.name, roles: p.roles, isApprover: p.isApprover, sessionVersion: p.sessionVersion }));
  const [supplier] = await db.insert(s.suppliers).values({ code: "CT-REQUEST", name: "CT恢复" }).returning();
  const [spu] = await db.insert(s.spus).values({ code: "STOCK-RECEIPT", nameCn: "库存恢复" }).returning();
  const [sku] = await db.insert(s.skus).values({ spuId: spu.id, code: "STOCK-RECEIPT", name: "库存恢复", skuType: "raw", baseUom: "kg" }).returning(); skuId = sku.id;
  const [wh] = await db.insert(s.warehouses).values({ code: "STOCK-RECEIPT", name: "库存恢复", kind: "raw", accountingMode: "realtime" }).returning(); warehouseId = wh.id;
  const [po] = await db.insert(s.poDocs).values({docNo:"CT-REQUEST-PO",supplierId:supplier.id,createdBy:actor.id,status:"completed"}).returning();poId=po.id;
  const [line] = await db.insert(s.poLines).values({poId,skuId,lineType:"raw",purchaseUom:"kg",uomFactor:"1",qty:"10",price:"1",receivedQty:"10"}).returning();poLineId=line.id;

});
afterAll(async () => close());
afterEach(async () => {
  vi.restoreAllMocks(); token = null;
  await db.update(s.users).set({ active: true, roles: actor.roles, sessionVersion: actor.sessionVersion }).where(eq(s.users.id, actor.id));
  await db.update(s.warehouses).set({ active: true }).where(eq(s.warehouses.id, warehouseId));
});
const input = () => ({ requestKey: randomUUID(), poId, warehouseId, lines: [{ poLineId, skuId, qty: "0.0001", batchId: null }] });
const snapshot = async () => ({
  docs: await db.select().from(s.ctDocs).orderBy(s.ctDocs.id), lines: await db.select().from(s.ctLines).orderBy(s.ctLines.id),
  receipt: await db.select().from(s.ctCreateRequests).orderBy(s.ctCreateRequests.id), audits: await db.select().from(s.auditLogs).orderBy(s.auditLogs.id),
  counters: await db.select().from(s.docCounters), ledger: await db.select().from(s.stockLedger),
});
it("same account/key and normalized intent replays exactly once without posting", async () => {
  const body = input(), before = await snapshot(), first = await createCtRequest(actor, body, db);
  expect(await createCtRequest(actor, { ...body, requestKey: body.requestKey.toUpperCase(), lines: [{ poLineId, skuId, qty: "00.0001", batchId: null }] }, db)).toEqual(first);
  const after = await snapshot();
  for (const key of ["docs", "lines", "receipt", "audits"] as const) expect(after[key].length).toBe(before[key].length + 1);
  expect(after.ledger).toEqual(before.ledger);
});
it.each(["quantity", "reason", "remark", "batch", "line-count"])("same key with changed %s conflicts without another write", async field => {
  const body = input(); await createCtRequest(actor, body, db); const before = await snapshot();
  const changed = field === "remark" ? { ...body, remark: "different" } : { ...body, lines: field === "line-count" ? [...body.lines, ...body.lines]
    : [{ ...body.lines[0], ...(field === "quantity" ? { qty: "1" } : field === "reason" ? { reason: "不同退货原因" } : { batchId: 123 }) }] };
  await expect(createCtRequest(actor, changed, db)).rejects.toMatchObject({ status: 409 }); expect(await snapshot()).toEqual(before);
});
it("read-only lookup returns current status, not a fabricated fresh draft, and can recover after source disable", async () => {
  const body = input(), first = await createCtRequest(actor, body, db);
  await db.update(s.ctDocs).set({ status: "void" }).where(eq(s.ctDocs.id, first.document.id));
  await db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, warehouseId));
  const before = await snapshot();
  expect((await getCtCreateResult(actor, body.requestKey, db)).document?.status).toBe("void");
  expect((await createCtRequest(actor, body, db)).document.status).toBe("void"); expect(await snapshot()).toEqual(before);
});
it("actor-scoped receipts cannot reveal peers and separate intentional requests remain separate", async () => {
  const body = input(), first = await createCtRequest(actor, body, db);
  expect((await getCtCreateResult(peer, body.requestKey, db)).document).toBeNull();
  expect((await createCtRequest(peer, body, db)).document.id).not.toBe(first.document.id);
  expect((await createCtRequest(actor, { ...body, requestKey: randomUUID() }, db)).document.id).not.toBe(first.document.id);
});
it.each(["disabled", "role", "session"])("%s cannot retrieve or replay an existing receipt", async reason => {
  const body = input(); await createCtRequest(actor, body, db);
  await db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "role" ? { roles: ["ops"] } : { sessionVersion: actor.sessionVersion! + 1 }).where(eq(s.users.id, actor.id));
  const before = await snapshot();
  await expect(getCtCreateResult(actor, body.requestKey, db)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
  await expect(createCtRequest(actor, body, db)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 }); expect(await snapshot()).toEqual(before);
});
it("a rejected new request can be corrected using the same key", async () => {
  const body = input(); await db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, warehouseId)); const before = await snapshot();
  await expect(createCtRequest(actor, body, db)).rejects.toMatchObject({ status: 400 }); expect(await snapshot()).toEqual(before);
  expect((await getCtCreateResult(actor, body.requestKey, db)).document).toBeNull();
  await db.update(s.warehouses).set({ active: true }).where(eq(s.warehouses.id, warehouseId));
  expect((await createCtRequest(actor, body, db)).document.status).toBe("draft");
});
it("audit failure rolls back receipt, number, document and lines before checked retry", async () => {
  const body = input(), before = await snapshot(); vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("stock receipt audit fault"));
  await expect(createCtRequest(actor, body, db)).rejects.toThrow("stock receipt audit fault"); expect(await snapshot()).toEqual(before);
  expect((await createCtRequest(actor, body, db)).document.status).toBe("draft");
});
it("receipt insertion failure also rolls back the nested document/audit transaction", async () => {
  const body = input(), before = await snapshot(), transaction = db.transaction.bind(db);
  vi.spyOn(db, "transaction").mockImplementationOnce(callback => transaction(tx => callback(new Proxy(tx, { get(target, property, receiver) {
    if (property === "insert") return (table: unknown) => { if (table === s.ctCreateRequests) throw Error("receipt insert fault"); return target.insert(table as typeof s.ctCreateRequests); };
    return Reflect.get(target, property, receiver);
  } }))));
  await expect(createCtRequest(actor, body, db)).rejects.toThrow("receipt insert fault"); expect(await snapshot()).toEqual(before);
});
it("database enforces immutable and unique receipts", async () => {
  const body = input(); await createCtRequest(actor, body, db);
  const [r] = await db.select().from(s.ctCreateRequests);
  await expect(db.update(s.ctCreateRequests).set({ requestHash: "a".repeat(64) }).where(eq(s.ctCreateRequests.id, r.id))).rejects.toThrow();
  await expect(db.delete(s.ctCreateRequests).where(eq(s.ctCreateRequests.id, r.id))).rejects.toThrow();
  await expect(db.execute(sql`TRUNCATE ct_create_requests`)).rejects.toThrow();
  await expect(db.insert(s.ctCreateRequests).values({ requestedBy: r.requestedBy, requestKey: r.requestKey, ctDocId: r.ctDocId, requestHash: r.requestHash })).rejects.toThrow();
});
it("cancellation fences the account/key without numbering, source reads, documents or inventory", async () => {
  const body = input(), before = await snapshot();
  await db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, warehouseId));
  const result = await cancelCtCreateRequest(actor, { requestKey: body.requestKey.toUpperCase() }, db);
  expect(result).toEqual({ requestKey: body.requestKey, document: null, cancelled: true });
  const after = await snapshot();
  for (const key of ["docs", "lines", "counters", "ledger"] as const) expect(after[key]).toEqual(before[key]);
  expect(after.receipt).toHaveLength(before.receipt.length + 1); expect(after.audits).toHaveLength(before.audits.length + 1);
  expect(after.receipt.at(-1)).toMatchObject({ cancelled: true, requestHash: null, ctDocId: null });
  expect(after.audits.at(-1)).toMatchObject({ userId: actor.id, entity: "ct_create_request", action: "cancel", after: { requestKey: body.requestKey, cancelled: true, documentId: null } });
  expect(await cancelCtCreateRequest(actor, { requestKey: body.requestKey }, db)).toEqual(result);
  expect(await getCtCreateResult(actor, body.requestKey, db)).toEqual(result);
  await expect(createCtRequest(actor, body, db)).rejects.toMatchObject({ status: 409 });
  await expect(createCtRequest(actor, { ...body, remark: "different intent" }, db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(after);
});
it("cancelling after creation returns the original document without cancelling it or adding audit", async () => {
  const body = input(), created = await createCtRequest(actor, body, db), before = await snapshot();
  expect(await cancelCtCreateRequest(actor, { requestKey: body.requestKey }, db)).toEqual(created);
  expect(await snapshot()).toEqual(before);
});
it("cancellation audit failure rolls back the fence and a later create is still possible", async () => {
  const body = input(), before = await snapshot(); vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("cancel audit fault"));
  await expect(cancelCtCreateRequest(actor, { requestKey: body.requestKey }, db)).rejects.toThrow("cancel audit fault");
  expect(await snapshot()).toEqual(before); expect((await getCtCreateResult(actor, body.requestKey, db)).document).toBeNull();
  expect((await createCtRequest(actor, body, db)).document.status).toBe("draft");
});
it("cancellation and lookup are account scoped; a peer does not cancel this actor's request", async () => {
  const body = input(); await cancelCtCreateRequest(peer, { requestKey: body.requestKey }, db);
  expect(await getCtCreateResult(actor, body.requestKey, db)).toEqual({ requestKey: body.requestKey, document: null });
  expect((await createCtRequest(actor, body, db)).document.status).toBe("draft");
});
it.each(["disabled", "role", "session"])("%s cannot cancel new or existing requests", async reason => {
  const body = input(); await cancelCtCreateRequest(actor, { requestKey: body.requestKey }, db);
  await db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "role" ? { roles: ["ops"] } : { sessionVersion: actor.sessionVersion! + 1 }).where(eq(s.users.id, actor.id));
  const before = await snapshot();
  for (const key of [body.requestKey, randomUUID()]) await expect(cancelCtCreateRequest(actor, { requestKey: key }, db)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
  expect(await snapshot()).toEqual(before);
});
it("database rejects mixed or empty creation outcomes and keeps cancellation immutable", async () => {
  const body = input(); await cancelCtCreateRequest(actor, { requestKey: body.requestKey }, db);
  const [r] = await db.select().from(s.ctCreateRequests).where(eq(s.ctCreateRequests.requestKey, body.requestKey));
  await expect(db.update(s.ctCreateRequests).set({ cancelled: false }).where(eq(s.ctCreateRequests.id, r.id))).rejects.toThrow();
  await expect(db.delete(s.ctCreateRequests).where(eq(s.ctCreateRequests.id, r.id))).rejects.toThrow();
  for (const invalid of [{}, { cancelled: true, requestHash: "a".repeat(64) }, { cancelled: false, requestHash: "a".repeat(64) }])
    await expect(db.insert(s.ctCreateRequests).values({ requestedBy: actor.id, requestKey: randomUUID(), ...invalid })).rejects.toThrow();
});
it("cancel HTTP authenticates first, rejects extra input and returns a no-store terminal result", async () => {
  const post = (body: unknown) => CANCEL(new NextRequest("http://localhost/api/matflow/ct/cancel-create", { method: "POST", body: JSON.stringify(body) }));
  expect((await post({})).status).toBe(401); token = actor;
  const body = { requestKey: randomUUID() }; expect((await post({ ...body, actorId: peer.id })).status).toBe(400);
  const r = await post(body); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await r.json()).toEqual({ ...body, document: null, cancelled: true });
});
it("HTTP requires a key and lookup rejects ambiguous parameters, returns no-store and current account only", async () => {
  token = actor; const body = input();
  const post = (v: unknown) => POST(new NextRequest("http://localhost/api/matflow/ct", { method: "POST", headers: { "x-scm-ct-create-contract": "2" }, body: JSON.stringify(v) }));
  const before = await snapshot();
  const oldClient = await POST(new NextRequest("http://localhost/api/matflow/ct", { method: "POST", body: JSON.stringify(body) }));
  expect(oldClient.status).toBe(400); expect((await oldClient.json()).error).toContain("刷新页面"); expect(await snapshot()).toEqual(before);
  expect((await post({ ...body, requestKey: undefined })).status).toBe(400);
  expect((await post(body)).status).toBe(201);
  const get = (q: string) => GET(new NextRequest(`http://localhost/api/matflow/ct/create-result?${q}`));
  const r = await get(`requestKey=${body.requestKey}`); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store");
  for (const q of ["", "requestKey=no", `requestKey=${body.requestKey}&requestKey=${body.requestKey}`, `requestKey=${body.requestKey}&actorId=1`]) expect((await get(q)).status).toBe(400);
  token = peer; expect((await (await get(`requestKey=${body.requestKey}`)).json()).document).toBeNull();
  token = null; expect((await get(`requestKey=${body.requestKey}`)).status).toBe(401);
});
it("missing physical identity and immutable source changes cannot replay a receipt", async () => {
  const body = input(); await createCtRequest(actor, body, db); const before = await snapshot();
  for (const changed of [{ ...body, poId: poId + 1 }, { ...body, warehouseId: warehouseId + 1 },
    { ...body, lines: [{ ...body.lines[0], poLineId: poLineId + 1 }] }, { ...body, lines: [{ ...body.lines[0], skuId: skuId + 1 }] }]) {
    await expect(createCtRequest(actor, changed, db)).rejects.toMatchObject({ status: 409 }); expect(await snapshot()).toEqual(before);
  }
  await expect(createCtRequest(actor, { ...input(), lines: [{ poLineId, skuId, qty: "1" }] }, db)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
