import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { approveSh, confirmInbound, createQc, createSh, submitSh } from "@/server/modules/matflow/sh";
import { createTestDb, type TestDb } from "../helpers/db";

describe("收货写入的当前身份与原子提交", () => {
  let db: TestDb, n = 0;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(s.approvalConfigs).values({ docType: "sh", approverRole: "warehouse" });
  });
  async function fixture() {
    const code = `SHB-${++n}`;
    const [maker, checker] = await db.insert(s.users).values([
      { name: code, roles: ["warehouse"] }, { name: `${code}-复核`, roles: ["warehouse"], isApprover: true },
    ]).returning();
    const [spu] = await db.insert(s.spus).values({ code, nameCn: code }).returning();
    const [sku] = await db.insert(s.skus).values({ code, name: code, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
    const [sup] = await db.insert(s.suppliers).values({ code, name: code, kinds: ["raw"] }).returning();
    const [wh] = await db.insert(s.warehouses).values({ code, name: code, kind: "raw", accountingMode: "realtime" }).returning();
    const [po] = await db.insert(s.poDocs).values({ docNo: `PO-${code}`, supplierId: sup.id, status: "in_progress", createdBy: maker.id }).returning();
    await db.insert(s.poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty: "1", uomFactor: "1", price: "1" });
    const actor = { id: maker.id, name: maker.name, roles: maker.roles, isApprover: false };
    const approver = { id: checker.id, name: checker.name, roles: checker.roles, isApprover: true };
    const input = { sourceType: "po", sourceId: po.id, warehouseId: wh.id, lines: [{ skuId: sku.id, actualQty: "0.1" }] };
    const sh = await createSh(actor, input, db);
    return { actor, approver, sh, input, po, wh };
  }
  const current = async (id: number) => (await db.select().from(s.shDocs).where(eq(s.shDocs.id, id)))[0];
  const audits = (id: number, action: string) => db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "sh"), eq(s.auditLogs.entityId, id), eq(s.auditLogs.action, action)));

  it("提交审计失败，状态和版本回滚，可原版本显式重试", async () => {
    const f = await fixture();
    await db.execute(sql`CREATE FUNCTION sh_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='sh' AND NEW.action='submit' THEN RAISE EXCEPTION 'synthetic submit audit fail'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER sh_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION sh_test_audit_fail()`);
    try {
      await expect(submitSh(f.actor, f.sh.id, f.sh.version, db)).rejects.toThrow();
      expect(await current(f.sh.id)).toMatchObject({ status: "draft", version: f.sh.version });
      expect(await audits(f.sh.id, "submit")).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER sh_test_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION sh_test_audit_fail()`);
    }
    expect(await submitSh(f.actor, f.sh.id, f.sh.version, db)).toMatchObject({ status: "pending", version: f.sh.version + 1 });
  });

  it("停用制单人不能沿用旧身份创建或提交", async () => {
    const f = await fixture();
    await db.update(s.users).set({ active: false }).where(eq(s.users.id, f.actor.id));
    await expect(createSh(f.actor, f.input, db)).rejects.toMatchObject({ status: 403 });
    await expect(submitSh(f.actor, f.sh.id, f.sh.version, db)).rejects.toMatchObject({ status: 403 });
  });

  it("非制单人降权后不能代提交", async () => {
    const f = await fixture();
    await db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, f.approver.id));
    await expect(submitSh(f.approver, f.sh.id, f.sh.version, db)).rejects.toMatchObject({ status: 403 });
    expect(await current(f.sh.id)).toMatchObject({ status: "draft" });
  });

  it.each(["inactive", "role", "approver"] as const)("审批人的%s资格撤销后不能驳回", async kind => {
    const f = await fixture(), pending = await submitSh(f.actor, f.sh.id, f.sh.version, db);
    await db.update(s.users).set(kind === "inactive" ? { active: false } : kind === "role" ? { roles: ["ops"] } : { isApprover: false }).where(eq(s.users.id, f.approver.id));
    await expect(approveSh(f.approver, f.sh.id, { action: "reject", version: pending.version }, db)).rejects.toMatchObject({ status: 403 });
    expect(await current(f.sh.id)).toMatchObject({ status: "pending" });
    expect(await audits(f.sh.id, "reject")).toHaveLength(0);
  });

  it("HTTP身份版本失效后创建、提交、审批、检验、入库全部拒绝", async () => {
    const f = await fixture(), old = { ...f.actor, sessionVersion: 0 }, oldChecker = { ...f.approver, sessionVersion: 0 };
    await db.update(s.users).set({ sessionVersion: 1 }).where(eq(s.users.id, old.id));
    await expect(createSh(old, f.input, db)).rejects.toMatchObject({ status: 401 });
    await expect(submitSh(old, f.sh.id, f.sh.version, db)).rejects.toMatchObject({ status: 401 });
    const pending = await submitSh(f.actor, f.sh.id, f.sh.version, db);
    await db.update(s.users).set({ sessionVersion: 1 }).where(eq(s.users.id, oldChecker.id));
    await expect(approveSh(oldChecker, f.sh.id, { action: "approve", version: pending.version }, db)).rejects.toMatchObject({ status: 401 });
    await approveSh(f.approver, f.sh.id, { action: "approve", version: pending.version }, db);
    const [line] = await db.select().from(s.shLines).where(eq(s.shLines.shId, f.sh.id));
    await expect(createQc(old, { shId: f.sh.id, lines: [{ shLineId: line.id, passQty: "0.1", failQty: "0", concessionQty: "0" }] }, db)).rejects.toMatchObject({ status: 401 });
    await expect(confirmInbound(old, f.sh.id, db)).rejects.toMatchObject({ status: 401 });
  });

  it.each(["po", "warehouse"] as const)("建单事务开始前%s失效，不能沿用预读结果写草稿", async target => {
    const f = await fixture(), original = db.transaction.bind(db);
    const delayed = new Proxy(db, { get(obj, prop) {
      if (prop === "transaction") return async (callback: Parameters<TestDb["transaction"]>[0]) => {
        if (target === "po") await db.update(s.poDocs).set({ status: "closed" }).where(eq(s.poDocs.id, f.po.id));
        else await db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, f.wh.id));
        return original(callback);
      };
      return Reflect.get(obj, prop);
    } });
    await expect(createSh(f.actor, f.input, delayed)).rejects.toMatchObject({ status: target === "po" ? 409 : 400 });
    expect(await db.select().from(s.shDocs).where(eq(s.shDocs.sourceId, f.po.id))).toHaveLength(1);
  });

  it("活跃制单人提交规则保留，同版本重复只有一次变更和审计", async () => {
    const f = await fixture();
    await db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, f.actor.id));
    const results = await Promise.allSettled([submitSh(f.actor, f.sh.id, f.sh.version, db), submitSh(f.actor, f.sh.id, f.sh.version, db)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await audits(f.sh.id, "submit")).toHaveLength(1);
  });

  it("JG来源在事务开始前关闭也必须拒绝创建", async () => {
    const f = await fixture(), code = `JG-SHB-${n}`, productSkuId = f.input.lines[0].skuId;
    const [bom] = await db.insert(s.boms).values({ productSkuId, versionNo: code }).returning();
    const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${code}`, productSkuId, qty: "1", supplierId: f.po.supplierId, feeRatePlan: "1", bomId: bom.id, createdBy: f.actor.id }).returning();
    const [jg] = await db.insert(s.jgDocs).values({ docNo: code, woId: wo.id, supplierId: f.po.supplierId, productSkuId, qty: "1", feeRateCurrent: "1", status: "in_progress", createdBy: f.actor.id }).returning();
    const original = db.transaction.bind(db);
    const delayed = new Proxy(db, { get(obj, prop) {
      if (prop === "transaction") return async (callback: Parameters<TestDb["transaction"]>[0]) => {
        await db.update(s.jgDocs).set({ status: "closed" }).where(eq(s.jgDocs.id, jg.id));
        return original(callback);
      };
      return Reflect.get(obj, prop);
    } });
    await expect(createSh(f.actor, { ...f.input, sourceType: "jg", sourceId: jg.id }, delayed)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(s.shDocs).where(and(eq(s.shDocs.sourceType, "jg"), eq(s.shDocs.sourceId, jg.id)))).toHaveLength(0);
  });
});
