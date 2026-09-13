import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { approveWo, createWo, getWo, getWoCreateResult, submitWo, transitionWO, withdrawWO } from "@/server/modules/outsource/wo";
import { POST as createRoute } from "@/app/api/outsource/wo/route";
import { GET as resultRoute } from "@/app/api/outsource/wo/create-result/route";
import { createWoSchema } from "@/server/modules/outsource/schemas";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], seq = 0;
let routeActor: SessionUser;
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: async () => routeActor }));
beforeAll(async () => {
  ({ db, client } = await createTestDb());
  await db.insert(s.approvalConfigs).values({ docType: "wo", approverRole: "pmc" });
});
afterAll(async () => { await client.close(); });
async function fixture() {
  const code = `WO-UP-${++seq}`;
  const [actor, checker, other] = await db.insert(s.users).values([
    { name: `${code}制单`, roles: ["pmc"], isApprover: true },
    { name: `${code}审批`, roles: ["pmc"], isApprover: true },
    { name: `${code}其他`, roles: ["warehouse"] },
  ]).returning();
  const [spu] = await db.insert(s.spus).values({ code, nameCn: "合成上游验证" }).returning();
  const [product, material] = await db.insert(s.skus).values([
    { code: `${code}-FG`, spuId: spu.id, skuType: "finished" as const, baseUom: "支" },
    { code: `${code}-MAT`, spuId: spu.id, skuType: "raw" as const, baseUom: "个" },
  ]).returning();
  const [supplier] = await db.insert(s.suppliers).values({ code, name: "合成工厂", status: "qualified" }).returning();
  const [bom] = await db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1", status: "active" }).returning();
  await db.insert(s.bomLines).values({ bomId: bom.id, materialSkuId: material.id, qtyPer: "1" });
  const input = { productSkuId: product.id, supplierId: supplier.id, qty: "3.0001", feeRatePlan: "1.25" };
  return { actor, checker, other, product, supplier, bom, input };
}
const state = async () => ({ docs: await db.select().from(s.woDocs), counters: await db.select().from(s.docCounters), audit: await db.select().from(s.auditLogs) });
const events = (id: number, action: string) => db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "wo"), eq(s.auditLogs.entityId, id), eq(s.auditLogs.action, action)));

it("manual creation replay returns the same document, number and audit after mutable qualification changes", async () => {
  const f = await fixture(), requestKey = randomUUID();
  const first = await createWo(f.actor, { ...f.input, requestKey, remark: "  test  " }, db);
  await db.update(s.boms).set({ status: "retired" }).where(eq(s.boms.id, f.bom.id));
  await db.update(s.suppliers).set({ status: "paused" }).where(eq(s.suppliers.id, f.supplier.id));
  const before = await state();
  expect(await createWo(f.actor, { ...f.input, requestKey: requestKey.toUpperCase(), feeRatePlan: "01.25", remark: "test" }, db)).toEqual(first);
  expect(await state()).toEqual(before);
  expect(await getWoCreateResult(f.actor, requestKey, db)).toEqual({ requestKey, document: { id: first.id, docNo: first.docNo, status: "draft" } });
  expect(await events(first.id, "create")).toHaveLength(1);
});
it.each([{ qty: "4" }, { feeRatePlan: "1.26" }, { remark: "other" }, { dueDate: "2026-09-14" }, { orderType: "repeat" }, { bhId: 9999 }, { supplierId: 9999 }])("a reused WO creation key cannot change intent %j", async change => {
  const f = await fixture(), requestKey = randomUUID();
  await createWo(f.actor, { ...f.input, requestKey }, db);
  const before = await state();
  await expect(createWo(f.actor, { ...f.input, requestKey, ...change }, db)).rejects.toMatchObject({ status: 409 });
  expect(await state()).toEqual(before);
});
it("receipt is actor-scoped, and replay/lookup recheck current role, activation and session", async () => {
  const f = await fixture(), requestKey = randomUUID();
  const original = await createWo(f.actor, { ...f.input, requestKey }, db);
  expect((await getWoCreateResult(f.checker, requestKey, db)).document).toBeNull();
  const other = await createWo(f.checker, { ...f.input, requestKey }, db);
  expect(other.id).not.toBe(original.id);
  await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, f.actor.id));
  await expect(getWoCreateResult(f.actor, requestKey, db)).rejects.toMatchObject({ status: 403 });
  await expect(createWo(f.actor, { ...f.input, requestKey }, db)).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ roles: ["pmc"], active: false }).where(eq(s.users.id, f.actor.id));
  await expect(getWoCreateResult(f.actor, requestKey, db)).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ active: true, sessionVersion: f.actor.sessionVersion + 1 }).where(eq(s.users.id, f.actor.id));
  await expect(getWoCreateResult(f.actor, requestKey, db)).rejects.toMatchObject({ status: 401 });
});
it("receipt insertion failure rolls back draft, numbering and audit, and the same request safely retries", async () => {
  const f = await fixture(), requestKey = randomUUID(), before = await state();
  await client.exec("CREATE FUNCTION fail_wo_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt fault'; END $$; CREATE TRIGGER fail_wo_receipt BEFORE INSERT ON wo_create_requests FOR EACH ROW EXECUTE FUNCTION fail_wo_receipt();");
  try { await expect(createWo(f.actor, { ...f.input, requestKey }, db)).rejects.toThrow(); }
  finally { await client.exec("DROP TRIGGER fail_wo_receipt ON wo_create_requests; DROP FUNCTION fail_wo_receipt();"); }
  expect(await state()).toEqual(before);
  expect((await getWoCreateResult(f.actor, requestKey, db)).document).toBeNull();
  const created = await createWo(f.actor, { ...f.input, requestKey }, db);
  expect((await getWoCreateResult(f.actor, requestKey, db)).document?.id).toBe(created.id);
});
it("the database enforces immutable unique receipt identity", async () => {
  const f = await fixture(), requestKey = randomUUID();
  await createWo(f.actor, { ...f.input, requestKey }, db);
  const [receipt] = await db.select().from(s.woCreateRequests).where(eq(s.woCreateRequests.requestKey, requestKey));
  await expect(db.insert(s.woCreateRequests).values({ requestedBy: receipt.requestedBy, requestKey, requestHash: receipt.requestHash, woId: receipt.woId })).rejects.toThrow();
  await expect(db.update(s.woCreateRequests).set({ requestKey: randomUUID() }).where(eq(s.woCreateRequests.id, receipt.id))).rejects.toThrow();
  await expect(db.delete(s.woCreateRequests).where(eq(s.woCreateRequests.id, receipt.id))).rejects.toThrow();
  await expect(client.exec("TRUNCATE wo_create_requests")).rejects.toThrow();
});
it("manual HTTP creation requires a key, exposes only its receipt, and lookup never returns another actor's result", async () => {
  const f = await fixture(); routeActor = f.actor;
  const post = (body: unknown) => createRoute(new NextRequest("http://localhost/api/outsource/wo", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
  const before = await state();
  expect((await post(f.input)).status).toBe(400);
  expect(await state()).toEqual(before);
  const requestKey = randomUUID(), response = await post({ ...f.input, requestKey });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["document", "requestKey"]);
  expect(Object.keys(body.document).sort()).toEqual(["docNo", "id", "status"]);
  const url = `http://localhost/api/outsource/wo/create-result?requestKey=${requestKey}`;
  const lookup = await resultRoute(new NextRequest(url));
  expect(lookup.headers.get("cache-control")).toBe("private, no-store");
  expect(await lookup.json()).toEqual(body);
  routeActor = f.checker;
  expect(await (await resultRoute(new NextRequest(url))).json()).toEqual({ requestKey, document: null });
});

it("creates exact quantity/fee, submits once, and snapshots only after independent approval; no stock effects", async () => {
  const f = await fixture(), stock = await db.select().from(s.stockLedger);
  const wo = await createWo(f.actor, f.input, db);
  expect(wo).toMatchObject({ status: "draft", qty: "3.0001", feeRatePlan: "1.25", bomId: f.bom.id });
  const pending = await submitWo(f.actor, wo.id, wo.version, db);
  expect(pending).toMatchObject({ status: "pending", version: wo.version + 1 });
  expect(await db.select().from(s.woLines).where(eq(s.woLines.woId, wo.id))).toEqual([]);
  await expect(submitWo(f.actor, wo.id, wo.version, db)).rejects.toMatchObject({ status: 409 });
  expect(await events(wo.id, "submit")).toHaveLength(1);
  await expect(approveWo(f.actor, wo.id, { action: "approve", version: pending.version }, db)).rejects.toMatchObject({ status: 403 });
  await approveWo(f.checker, wo.id, { action: "approve", version: pending.version }, db);
  expect(await db.select().from(s.woLines).where(eq(s.woLines.woId, wo.id))).toMatchObject([{ grossReq: "3.0001" }]);
  expect(await approveWo(f.checker, wo.id, { action: "approve", version: pending.version }, db)).toMatchObject({ idempotent: true });
  expect(await events(wo.id, "snapshot")).toHaveLength(1);
  expect(await db.select().from(s.stockLedger)).toEqual(stock);
});
it("creation uses current PMC role, account status and session, not the caller claims", async () => {
  const f = await fixture(), before = await state();
  await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, f.actor.id));
  await expect(createWo(f.actor, f.input, db)).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ roles: ["pmc"], active: false }).where(eq(s.users.id, f.actor.id));
  await expect(createWo(f.actor, f.input, db)).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ active: true, sessionVersion: f.actor.sessionVersion + 1 }).where(eq(s.users.id, f.actor.id));
  await expect(createWo(f.actor, f.input, db)).rejects.toMatchObject({ status: 401 });
  expect(await state()).toEqual(before);
});
it("BH access is reloaded from current DB scope even if caller omits or forges unrestricted scope", async () => {
  const f = await fixture();
  const [bh] = await db.insert(s.bhDocs).values({ docNo: `BH-UP-${seq}`, status: "approved", createdBy: f.other.id, orderType: "repeat" }).returning();
  await db.insert(s.bhLines).values({ bhId: bh.id, skuId: f.product.id, qty: "10" });
  await db.insert(s.userDataScopes).values([{ userId: f.actor.id, scopeKind: "channel", targetId: 11, createdBy: f.checker.id }, { userId: f.other.id, scopeKind: "channel", targetId: 12, createdBy: f.checker.id }]);
  for (const actor of [f.actor, { ...f.actor, channelScope: null }, { ...f.actor, channelScope: [12] }]) {
    await expect(createWo(actor, { ...f.input, bhId: bh.id }, db)).rejects.toMatchObject({ status: 404 });
  }
  await db.update(s.userDataScopes).set({ targetId: 11 }).where(eq(s.userDataScopes.userId, f.other.id));
  expect(await createWo(f.actor, { ...f.input, bhId: bh.id }, db)).toMatchObject({ bhId: bh.id, orderType: "repeat" });
});
it.each(["paused", "blacklisted"] as const)("creation refuses %s factory and leaves no number/audit/doc", async status => {
  const f = await fixture(), before = await state();
  await db.update(s.suppliers).set({ status }).where(eq(s.suppliers.id, f.supplier.id));
  await expect(createWo(f.actor, f.input, db)).rejects.toMatchObject({ status: 400 });
  expect(await state()).toEqual(before);
});
it("creation rejects disabled/retyped product and missing active BOM", async () => {
  const f = await fixture(), before = await state();
  await db.update(s.skus).set({ active: false }).where(eq(s.skus.id, f.product.id));
  await expect(createWo(f.actor, f.input, db)).rejects.toMatchObject({ status: 400 });
  await db.update(s.skus).set({ active: true, skuType: "raw" }).where(eq(s.skus.id, f.product.id));
  await expect(createWo(f.actor, f.input, db)).rejects.toMatchObject({ status: 400 });
  await db.update(s.skus).set({ skuType: "finished" }).where(eq(s.skus.id, f.product.id));
  await db.update(s.boms).set({ status: "retired" }).where(eq(s.boms.id, f.bom.id));
  await expect(createWo(f.actor, f.input, db)).rejects.toMatchObject({ status: 404 });
  expect(await state()).toEqual(before);
});
it.each(["create", "submit"] as const)("%s audit failure rolls back all document/number/version changes; deliberate retry succeeds", async action => {
  const f = await fixture(), wo = action === "submit" ? await createWo(f.actor, f.input, db) : null;
  const before = await state(), spy = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("synthetic audit failure"));
  const run = () => wo ? submitWo(f.actor, wo.id, wo.version, db) : createWo(f.actor, f.input, db);
  try { await expect(run()).rejects.toThrow("synthetic audit failure"); } finally { spy.mockRestore(); }
  expect(await state()).toEqual(before);
  expect(await run()).toMatchObject({ status: wo ? "pending" : "draft" });
});
it("submit preserves owner/admin policy using fresh account, and rejects stale versions without mutation", async () => {
  const f = await fixture(), wo = await createWo(f.actor, f.input, db), before = await state();
  await expect(submitWo({ ...f.other, roles: ["admin"] }, wo.id, wo.version, db)).rejects.toMatchObject({ status: 403 });
  await expect(submitWo(f.actor, wo.id, wo.version + 1, db)).rejects.toMatchObject({ status: 409 });
  await db.update(s.users).set({ active: false }).where(eq(s.users.id, f.actor.id));
  await expect(submitWo(f.actor, wo.id, wo.version, db)).rejects.toMatchObject({ status: 403 });
  expect(await state()).toEqual(before);
  await db.update(s.users).set({ roles: ["admin"] }).where(eq(s.users.id, f.other.id));
  expect(await submitWo(f.other, wo.id, wo.version, db)).toMatchObject({ status: "pending" });
});
it("approval and rejection recheck current role and approver flag, including historical replay", async () => {
  const f = await fixture(), wo = await createWo(f.actor, f.input, db), pending = await submitWo(f.actor, wo.id, wo.version, db);
  const approve = (actor: SessionUser, action: "approve" | "reject" = "approve") => approveWo(actor, wo.id, { action, version: pending.version }, db);
  await db.update(s.users).set({ isApprover: false }).where(eq(s.users.id, f.checker.id));
  await expect(approve(f.checker)).rejects.toMatchObject({ status: 403 });
  await expect(approve(f.checker, "reject")).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ isApprover: true }).where(eq(s.users.id, f.checker.id));
  await approve(f.checker);
  await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, f.checker.id));
  await expect(approve(f.checker)).rejects.toMatchObject({ status: 403 });
  expect(await events(wo.id, "approve")).toHaveLength(1);
});
it("snapshot audit failure rolls back approval/status/lines, and independent rejection still works", async () => {
  const f = await fixture(), wo = await createWo(f.actor, f.input, db), pending = await submitWo(f.actor, wo.id, wo.version, db), before = await state();
  const original = audit.writeAudit, spy = vi.spyOn(audit, "writeAudit").mockImplementation(async (tx, event) => {
    if (event.action === "snapshot") throw Error("synthetic snapshot failure");
    return original(tx, event);
  });
  try { await expect(approveWo(f.checker, wo.id, { action: "approve", version: pending.version }, db)).rejects.toThrow("synthetic snapshot failure"); }
  finally { spy.mockRestore(); }
  expect(await state()).toEqual(before);
  expect(await db.select().from(s.woLines).where(eq(s.woLines.woId, wo.id))).toEqual([]);
  expect(await db.select().from(s.approvals).where(and(eq(s.approvals.docType, "wo"), eq(s.approvals.docId, wo.id)))).toEqual([]);
  expect(await approveWo(f.checker, wo.id, { action: "reject", version: pending.version }, db)).toMatchObject({ status: "draft" });
});
it("new BOM activation does not silently replace an existing WO's chosen BOM", async () => {
  const f = await fixture(), wo = await createWo(f.actor, f.input, db);
  await db.update(s.boms).set({ status: "retired" }).where(eq(s.boms.id, f.bom.id));
  await db.insert(s.boms).values({ productSkuId: f.product.id, versionNo: "2", status: "active" });
  const pending = await submitWo(f.actor, wo.id, wo.version, db);
  await approveWo(f.checker, wo.id, { action: "approve", version: pending.version }, db);
  expect(await events(wo.id, "snapshot")).toMatchObject([{ after: { bomId: f.bom.id, lineCount: 1 } }]);
});
it.each(["0.00001", "10000000000", "-1", "NaN", "1e20"])("creation refuses invalid quantity %s instead of rounding to zero or SQL overflow", qty => {
  expect(createWoSchema.safeParse({ productSkuId: 1, supplierId: 1, qty, feeRatePlan: "1" }).success).toBe(false);
});
it.each(["0.001", "1000000000000", "0", "-1"])("creation refuses invalid fee %s instead of silent rounding", feeRatePlan => {
  expect(createWoSchema.safeParse({ productSkuId: 1, supplierId: 1, qty: "1", feeRatePlan }).success).toBe(false);
});
it("submit rejects malformed IDs and versions before querying", async () => {
  const f = await fixture();
  for (const invalid of [0, -1, 0.5, NaN, 2147483648]) {
    await expect(submitWo(f.actor, invalid, 1, db)).rejects.toMatchObject({ status: 400 });
    await expect(submitWo(f.actor, 1, invalid, db)).rejects.toMatchObject({ status: 400 });
  }
});
it("detail hints follow current actor/configuration, not caller claims, and retain separate rejection and withdrawal", async () => {
  const f = await fixture(), wo = await createWo(f.actor, f.input, db);
  const read = (user?: SessionUser) => getWo(wo.id, db, user);
  expect((await read()).taskActions).toBeNull();
  expect((await read(f.actor)).taskActions).toMatchObject({ submit: true, approve: false });
  expect((await read({ ...f.other, roles: ["admin"] })).taskActions).toMatchObject({ submit: false });
  await submitWo(f.actor, wo.id, wo.version, db);
  expect((await read(f.actor)).taskActions).toMatchObject({ approve: false, reject: false, withdraw: true });
  expect((await read(f.checker)).taskActions).toMatchObject({ approve: true, reject: true, withdraw: false });
  await db.update(s.approvalConfigs).set({ approverRole: "quality" }).where(eq(s.approvalConfigs.docType, "wo"));
  try { expect((await read(f.checker)).taskActions).toMatchObject({ approve: false, reject: false }); }
  finally { await db.update(s.approvalConfigs).set({ approverRole: "pmc" }).where(eq(s.approvalConfigs.docType, "wo")); }
  await db.update(s.users).set({ active: false }).where(eq(s.users.id, f.checker.id));
  expect((await read(f.checker)).taskActions).toBeNull();
  expect((await read({ ...f.actor, sessionVersion: 999 })).taskActions).toBeNull();
});
it("withdraw rechecks current owner/admin, rolls audit failure back, and legal replay adds no second event", async () => {
  const f = await fixture(), wo = await createWo(f.actor, f.input, db), pending = await submitWo(f.actor, wo.id, wo.version, db);
  const before = await state();
  await expect(withdrawWO({ ...f.other, roles: ["admin"] }, wo.id, { version: pending.version }, db)).rejects.toMatchObject({ status: 403 });
  const spy = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("withdraw audit failure"));
  try { await expect(withdrawWO(f.actor, wo.id, { version: pending.version }, db)).rejects.toThrow("withdraw audit failure"); }
  finally { spy.mockRestore(); }
  expect(await state()).toEqual(before);
  await withdrawWO(f.actor, wo.id, { version: pending.version }, db);
  expect(await withdrawWO(f.actor, wo.id, { version: pending.version }, db)).toMatchObject({ idempotent: true });
  expect(await events(wo.id, "withdraw")).toHaveLength(1);
});
it("manual closure cannot use revoked PMC/admin claims, including after successful closure", async () => {
  const f = await fixture(), wo = await createWo(f.actor, f.input, db);
  await db.update(s.woDocs).set({ status: "approved" }).where(eq(s.woDocs.id, wo.id));
  const input = { action: "short_close", version: wo.version, reason: "合成停单核对" };
  await expect(transitionWO({ ...f.other, roles: ["pmc"] }, wo.id, input, db)).rejects.toMatchObject({ status: 403 });
  const spy = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("close audit failure"));
  try { await expect(transitionWO(f.actor, wo.id, input, db)).rejects.toThrow("close audit failure"); }
  finally { spy.mockRestore(); }
  expect((await getWo(wo.id, db, f.actor)).taskActions).toMatchObject({ manage: true, generate: true });
  await transitionWO(f.actor, wo.id, input, db);
  expect((await getWo(wo.id, db, f.actor)).taskActions).toMatchObject({ manage: false, generate: false });
  await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, f.actor.id));
  await expect(transitionWO(f.actor, wo.id, input, db)).rejects.toMatchObject({ status: 403 });
  expect(await events(wo.id, "short_close")).toHaveLength(1);
});
