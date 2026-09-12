import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { approveWo, createWo, submitWo } from "@/server/modules/outsource/wo";
import { createWoSchema } from "@/server/modules/outsource/schemas";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], seq = 0;
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
