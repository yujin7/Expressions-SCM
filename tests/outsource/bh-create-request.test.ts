import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import * as s from "@/db/schema";
import { createBhRequest, getBhCreateResult } from "@/server/modules/outsource/bh-create-request";
import { POST as manualPost } from "@/app/api/outsource/bh/route";
import { POST as livePost } from "@/app/api/replenish/draft/route";
import { GET } from "@/app/api/outsource/bh/create-result/route";
import { shanghaiMonthOf } from "@/server/core/business-day";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, close: () => Promise<void>, ops: SessionUser, pmc: SessionUser, peer: SessionUser, skuId: number;
let token: SessionUser | null, failAction = "";
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
vi.mock("@/server/auth", () => ({ auth: async () => token ? { user: { ...token, id: String(token.id) } } : null }));
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
    if (args[1].action === failAction) throw Error("injected BH receipt audit failure");
    return actual.writeAudit(...args);
  } };
});
beforeAll(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close();
  const people = await db.insert(s.users).values([{ name: "创建运营", roles: ["ops"] }, { name: "创建计划", roles: ["pmc"] }, { name: "另一个运营", roles: ["ops"] }]).returning();
  [ops, pmc, peer] = people.map(p => ({ id: p.id, name: p.name, roles: p.roles, isApprover: p.isApprover, sessionVersion: p.sessionVersion }));
  const [spu] = await db.insert(s.spus).values({ code: "BH-RECEIPT", nameCn: "恢复测试" }).returning();
  const [sku] = await db.insert(s.skus).values({ spuId: spu.id, code: "BH-RECEIPT-1", name: "精华", skuType: "finished", baseUom: "瓶" }).returning(); skuId = sku.id;
  await db.insert(s.approvalConfigs).values({ docType: "bh", approverRole: "pmc" });
});
afterAll(async () => { await close(); });
afterEach(async () => {
  failAction = "";
  for (const p of [ops, pmc, peer]) await db.update(s.users).set({ active: true, roles: p.roles, sessionVersion: p.sessionVersion }).where(eq(s.users.id, p.id));
  await db.update(s.skus).set({ active: true }).where(eq(s.skus.id, skuId));
});
const input = () => ({ requestKey: randomUUID(), remark: "核对需求", lines: [{ skuId, qty: "12.3456" }, { skuId, qty: "2" }] });
const state = async () => ({ docs: await db.select().from(s.bhDocs), lines: await db.select().from(s.bhLines), receipts: await db.select().from(s.bhCreateRequests), counters: await db.select().from(s.docCounters), audits: await db.select().from(s.auditLogs) });
const request = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

it("same request returns exactly one original document and preserves original independent lines", async () => {
  const v = input(), first = await createBhRequest(ops, v, "manual", db), before = await state();
  expect(await createBhRequest(ops, { ...v, requestKey: v.requestKey.toUpperCase(), lines: [v.lines[0], { skuId, qty: "2.0000" }] }, "manual", db)).toEqual(first);
  expect(await state()).toEqual(before);
  expect((await db.select().from(s.bhLines).where(eq(s.bhLines.bhId, first.document.id))).map(l => l.qty)).toEqual(["12.3456", "2.0000"]);
  expect(await getBhCreateResult(ops, v.requestKey, db)).toEqual(first);
  expect(Object.keys(first.document).sort()).toEqual(["docNo", "id", "status"]);
  expect(await db.select().from(s.stockLedger)).toHaveLength(0);
});
it.each(["quantity", "remark", "date", "order", "source"])("rejects changed %s intent without effects", async change => {
  const v = input(); await createBhRequest(ops, v, "manual", db); const before = await state();
  const modified = change === "quantity" ? { ...v, lines: [{ skuId, qty: "9" }] } : change === "remark" ? { ...v, remark: "别的需求" }
    : change === "date" ? { ...v, lines: [{ ...v.lines[0], expectDate: "2026-10-12" }, v.lines[1]] }
    : change === "order" ? { ...v, lines: [...v.lines].reverse() } : v;
  if (change === "source") await db.update(s.users).set({ roles: ["ops", "pmc"] }).where(eq(s.users.id, ops.id));
  await expect(createBhRequest(ops, modified, change === "source" ? "replenish" : "manual", db)).rejects.toMatchObject({ status: 409 });
  expect(await state()).toEqual(before);
});
it("another account cannot discover the receipt, even with the same key; legacy documents are not guessed", async () => {
  const v = input(), original = await createBhRequest(ops, v, "manual", db);
  expect(await getBhCreateResult(peer, v.requestKey, db)).toEqual({ requestKey: v.requestKey, source: null, document: null });
  const separate = await createBhRequest(peer, v, "manual", db); expect(separate.document.id).not.toBe(original.document.id);
  expect((await getBhCreateResult(ops, randomUUID(), db)).document).toBeNull();
});
it.each(["disabled", "role", "session"])("new, replay and read all reject stale %s authority", async change => {
  const v = input(); await createBhRequest(ops, v, "manual", db); const before = await state();
  await db.update(s.users).set(change === "disabled" ? { active: false } : change === "role" ? { roles: ["warehouse"] } : { sessionVersion: ops.sessionVersion! + 1 }).where(eq(s.users.id, ops.id));
  for (const action of [() => createBhRequest(ops, v, "manual", db), () => createBhRequest(ops, input(), "manual", db), () => getBhCreateResult(ops, v.requestKey, db)]) await expect(action()).rejects.toMatchObject({ status: change === "session" ? 401 : 403 });
  expect(await state()).toEqual(before);
});
it("replay returns current status even if the original SKU is now disabled", async () => {
  const v = input(), first = await createBhRequest(ops, v, "manual", db);
  await db.update(s.bhDocs).set({ status: "closed" }).where(eq(s.bhDocs.id, first.document.id));
  await db.update(s.skus).set({ active: false }).where(eq(s.skus.id, skuId));
  expect((await createBhRequest(ops, v, "manual", db)).document.status).toBe("closed");
});
it.each(["create", "draft_bh"])("%s audit failure rolls back document, number and receipt", async action => {
  const before = await state(); failAction = action;
  await expect(createBhRequest(action === "create" ? ops : pmc, input(), action === "create" ? "manual" : "replenish", db)).rejects.toThrow("injected");
  expect(await state()).toEqual(before);
});
it("receipt insert failure rolls back earlier successful document and audit writes", async () => {
  const before = await state();
  await db.execute(sql`CREATE FUNCTION fail_bh_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$`);
  await db.execute(sql`CREATE TRIGGER fail_bh_receipt_test BEFORE INSERT ON bh_create_requests FOR EACH ROW EXECUTE FUNCTION fail_bh_receipt_test()`);
  try { await expect(createBhRequest(ops, input(), "manual", db)).rejects.toThrow(); expect(await state()).toEqual(before); }
  finally { await db.execute(sql`DROP TRIGGER fail_bh_receipt_test ON bh_create_requests`); await db.execute(sql`DROP FUNCTION fail_bh_receipt_test()`); }
});
it("database receipts reject update, deletion and truncate", async () => {
  const v = input(); await createBhRequest(ops, v, "manual", db); const before = await state();
  await expect(db.update(s.bhCreateRequests).set({ requestHash: "0".repeat(64) }).where(eq(s.bhCreateRequests.requestKey, v.requestKey))).rejects.toThrow();
  await expect(db.delete(s.bhCreateRequests).where(eq(s.bhCreateRequests.requestKey, v.requestKey))).rejects.toThrow();
  await expect(db.execute(sql`TRUNCATE bh_create_requests`)).rejects.toThrow(); expect(await state()).toEqual(before);
});
it("HTTP creation requires a key, rejects bad dates and >200 lines, and returns a no-store lookup", async () => {
  token = ops; const v = input();
  expect((await manualPost(request("/api/outsource/bh", { lines: v.lines }))).status).toBe(400);
  expect((await manualPost(request("/api/outsource/bh", { ...v, lines: [{ skuId, qty: "1", expectDate: "2026-02-30" }] }))).status).toBe(400);
  expect((await manualPost(request("/api/outsource/bh", { ...v, lines: Array.from({ length: 201 }, () => v.lines[0]) }))).status).toBe(400);
  const first = await manualPost(request("/api/outsource/bh", v)); expect(first.status).toBe(201);
  const read = await GET(new NextRequest(`http://localhost/api/outsource/bh/create-result?requestKey=${v.requestKey}`));
  expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store"); expect(await read.json()).toEqual(await first.json());
  for (const query of ["", "requestKey=bad", `requestKey=${v.requestKey}&requestKey=${v.requestKey}`, `requestKey=${v.requestKey}&actorId=${peer.id}`]) expect((await GET(new NextRequest(`http://localhost/api/outsource/bh/create-result?${query}`))).status).toBe(400);
  token = null; expect((await GET(new NextRequest(`http://localhost/api/outsource/bh/create-result?requestKey=${v.requestKey}`))).status).toBe(401);
});
it("realtime HTTP preserves source audit and current role restrictions", async () => {
  const v = input(); token = ops;
  expect((await livePost(request("/api/replenish/draft", { requestKey: v.requestKey, items: v.lines }))).status).toBe(403);
  token = pmc;
  expect((await livePost(request("/api/replenish/draft", { items: v.lines }))).status).toBe(400);
  const response = await livePost(request("/api/replenish/draft", { requestKey: v.requestKey, items: v.lines })); expect(response.status).toBe(201);
  const result = await response.json(); expect(result.source).toBe("replenish");
  expect(await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "replenish"), eq(s.auditLogs.entityId, result.document.id)))).toHaveLength(1);
});
it("monthly freeze blocks only new realtime creation, never recovery of its committed original", async () => {
  const v = input(), first = await createBhRequest(pmc, v, "replenish", db);
  const [plan] = await db.insert(s.planningVersions).values({ name: "BH恢复计划", weekStart: "2026-09-01", engineVersion: "test", parameters: {}, sourceMeta: {},
    lineCount: 0, suggestedCount: 0, suppressedCount: 0, digest: "a".repeat(64), idempotencyKey: randomUUID(), createdBy: pmc.id }).returning();
  const [cycle] = await db.insert(s.sopCycles).values({ name: "BH恢复周期", month: shanghaiMonthOf(new Date()), planningVersionId: plan.id, planDigest: plan.digest,
    idempotencyKey: randomUUID(), status: "frozen", createdBy: pmc.id, frozenBy: pmc.id, frozenAt: new Date() }).returning();
  try {
    const before = await state();
    expect(await createBhRequest(pmc, v, "replenish", db)).toEqual(first);
    expect(await getBhCreateResult(pmc, v.requestKey, db)).toEqual(first);
    await expect(createBhRequest(pmc, input(), "replenish", db)).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
  } finally { await db.update(s.sopCycles).set({ status: "closed", executingBy: pmc.id, executingAt: new Date(), closedBy: pmc.id, closedAt: new Date() }).where(eq(s.sopCycles.id, cycle.id)); }
});
