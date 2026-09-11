import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { approveCt, createCt, submitCt } from "@/server/modules/matflow/ct";
import { createTestDb, type TestDb } from "../helpers/db";

describe("采购退货当前身份与提交原子性", () => {
  let db: TestDb, n = 0;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(s.approvalConfigs).values({ docType: "ct", approverRole: "warehouse" });
  });
  async function fixture() {
    const code = `CTB-${++n}`;
    const [maker, checker] = await db.insert(s.users).values([
      { name: code, roles: ["warehouse"] }, { name: `${code}-复核`, roles: ["warehouse"], isApprover: true },
    ]).returning();
    const [spu] = await db.insert(s.spus).values({ code, nameCn: code }).returning();
    const [sku] = await db.insert(s.skus).values({ code, name: code, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    const [sup] = await db.insert(s.suppliers).values({ code, name: code, kinds: ["raw"] }).returning();
    const [wh] = await db.insert(s.warehouses).values({ code, name: code, kind: "raw", accountingMode: "realtime" }).returning();
    const [po] = await db.insert(s.poDocs).values({ docNo: `PO-${code}`, supplierId: sup.id, status: "in_progress", createdBy: maker.id }).returning();
    const [line] = await db.insert(s.poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty: "1", uomFactor: "1", price: "1", receivedQty: "1" }).returning();
    const actor = { id: maker.id, name: maker.name, roles: maker.roles, isApprover: false };
    const approver = { id: checker.id, name: checker.name, roles: checker.roles, isApprover: true };
    const input = { poId: po.id, warehouseId: wh.id, lines: [{ poLineId: line.id, skuId: sku.id, qty: "0.1" }] };
    const ct = await createCt(actor, input, db);
    return { actor, approver, ct, input };
  }
  const current = async (id: number) => (await db.select().from(s.ctDocs).where(eq(s.ctDocs.id, id)))[0];
  const audits = (id: number, action: string) => db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "ct"), eq(s.auditLogs.entityId, id), eq(s.auditLogs.action, action)));

  it("提交审计失败，状态/版本保持草稿且可原版本重试", async () => {
    const f = await fixture();
    await db.execute(sql`CREATE FUNCTION ct_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='ct' AND NEW.action='submit' THEN RAISE EXCEPTION 'synthetic submit audit fail'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER ct_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ct_test_audit_fail()`);
    try {
      await expect(submitCt(f.actor, f.ct.id, f.ct.version, db)).rejects.toThrow();
      expect(await current(f.ct.id)).toMatchObject({ status: "draft", version: f.ct.version });
      expect(await audits(f.ct.id, "submit")).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER ct_test_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION ct_test_audit_fail()`);
    }
    expect(await submitCt(f.actor, f.ct.id, f.ct.version, db)).toMatchObject({ status: "pending", version: f.ct.version + 1 });
  });

  it("停用制单人不能以旧身份创建或提交", async () => {
    const f = await fixture();
    await db.update(s.users).set({ active: false }).where(eq(s.users.id, f.actor.id));
    await expect(createCt(f.actor, f.input, db)).rejects.toMatchObject({ status: 403 });
    await expect(submitCt(f.actor, f.ct.id, f.ct.version, db)).rejects.toMatchObject({ status: 403 });
  });

  it("非制单人降权后不能沿用旧仓管角色代提交", async () => {
    const f = await fixture();
    await db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, f.approver.id));
    await expect(submitCt(f.approver, f.ct.id, f.ct.version, db)).rejects.toMatchObject({ status: 403 });
    expect(await current(f.ct.id)).toMatchObject({ status: "draft" });
  });

  it.each(["inactive", "role", "approver"] as const)("审批人的%s资格已撤销，旧身份不能驳回", async (kind) => {
    const f = await fixture(), pending = await submitCt(f.actor, f.ct.id, f.ct.version, db);
    const patch = kind === "inactive" ? { active: false } : kind === "role" ? { roles: ["ops"] } : { isApprover: false };
    await db.update(s.users).set(patch).where(eq(s.users.id, f.approver.id));
    await expect(approveCt(f.approver, f.ct.id, { action: "reject", version: pending.version }, db)).rejects.toMatchObject({ status: 403 });
    expect(await current(f.ct.id)).toMatchObject({ status: "pending" });
    expect(await audits(f.ct.id, "reject")).toHaveLength(0);
  });

  it("HTTP身份版本失效后创建/提交/审批均拒绝", async () => {
    const f = await fixture();
    const actor = { ...f.actor, sessionVersion: 0 }, approver = { ...f.approver, sessionVersion: 0 };
    await db.update(s.users).set({ sessionVersion: 1 }).where(eq(s.users.id, actor.id));
    await expect(createCt(actor, f.input, db)).rejects.toMatchObject({ status: 401 });
    await expect(submitCt(actor, f.ct.id, f.ct.version, db)).rejects.toMatchObject({ status: 401 });
    const pending = await submitCt(f.actor, f.ct.id, f.ct.version, db);
    await db.update(s.users).set({ sessionVersion: 1 }).where(eq(s.users.id, approver.id));
    await expect(approveCt(approver, f.ct.id, { action: "reject", version: pending.version }, db)).rejects.toMatchObject({ status: 401 });
  });

  it("制单人本人规则保留；两次提交只有一次状态变更和审计", async () => {
    const f = await fixture();
    await db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, f.actor.id));
    const results = await Promise.allSettled([submitCt(f.actor, f.ct.id, f.ct.version, db), submitCt(f.actor, f.ct.id, f.ct.version, db)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await audits(f.ct.id, "submit")).toHaveLength(1);
    expect(await current(f.ct.id)).toMatchObject({ status: "pending", version: f.ct.version + 1 });
  });
});
