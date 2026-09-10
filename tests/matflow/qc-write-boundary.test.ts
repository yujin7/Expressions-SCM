import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLogs, qcLines, qcRecords, shDocs, shLines, skus, spus, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { confirmInbound, createQc } from "@/server/modules/matflow/sh";
import { createTestDb, type TestDb } from "../helpers/db";

describe("QC 一单一检事务边界", () => {
  let db: TestDb, sequence = 0;
  beforeAll(async () => { ({ db } = await createTestDb()); });
  async function fixture() {
    const suffix = String(++sequence);
    const [u] = await db.insert(users).values({ name: `检验${suffix}`, roles: ["warehouse"] }).returning();
    const actor: SessionUser = { id: u.id, name: u.name, roles: u.roles, isApprover: false };
    const [spu] = await db.insert(spus).values({ code: `QC-${suffix}`, nameCn: "检验产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: `QC-${suffix}`, spuId: spu.id, name: "检验件", skuType: "raw", baseUom: "kg" }).returning();
    const [wh] = await db.insert(warehouses).values({ code: `QC-${suffix}`, name: "原料仓", kind: "raw", accountingMode: "realtime" }).returning();
    const [sh] = await db.insert(shDocs).values({ docNo: `SH-QC-${suffix}`, status: "approved", sourceType: "po", sourceId: 100000, warehouseId: wh.id, createdBy: u.id }).returning();
    const [line] = await db.insert(shLines).values({ shId: sh.id, skuId: sku.id, actualQty: "0.3" }).returning();
    return { actor, sh, line, input: { shId: sh.id, lines: [{ shLineId: line.id, passQty: "0.1", failQty: "0.1", concessionQty: "0.1" }] } };
  }

  it("两个同时提交只有一份QC及一条审计，另一方409", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([createQc(f.actor, f.input, db), createQc(f.actor, f.input, db)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, message: expect.stringContaining("一单一检") });
    const rows = await db.select().from(qcRecords).where(eq(qcRecords.shId, f.sh.id));
    expect(rows).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "qc"), eq(auditLogs.entityId, rows[0].id), eq(auditLogs.action, "create")))).toHaveLength(1);
  });

  it("事务开始前单据已失效不能根据旧状态创建检验", async () => {
    const f = await fixture();
    // Deterministic boundary: commit a competing status transition just before the
    // service opens its transaction. Production PG lock-wait is verified separately.
    const original = db.transaction.bind(db);
    const delayed = new Proxy(db, { get(target, prop) {
      if (prop === "transaction") return async (callback: Parameters<TestDb["transaction"]>[0]) => {
        await db.update(shDocs).set({ status: "closed" }).where(eq(shDocs.id, f.sh.id));
        return original(callback);
      };
      return Reflect.get(target, prop);
    } });
    await expect(createQc(f.actor, f.input, delayed)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(qcRecords).where(eq(qcRecords.shId, f.sh.id))).toHaveLength(0);
  });

  it("停用账号及已移除仓管角色不能沿用旧会话检验/入库", async () => {
    const f = await fixture();
    await db.update(users).set({ active: false }).where(eq(users.id, f.actor.id));
    await expect(createQc(f.actor, f.input, db)).rejects.toMatchObject({ status: 403 });
    await expect(confirmInbound(f.actor, f.sh.id, db)).rejects.toMatchObject({ status: 403 });
    await db.update(users).set({ active: true, roles: ["ops"] }).where(eq(users.id, f.actor.id));
    await expect(createQc(f.actor, f.input, db)).rejects.toMatchObject({ status: 403 });
    await expect(confirmInbound(f.actor, f.sh.id, db)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(qcRecords).where(eq(qcRecords.shId, f.sh.id))).toHaveLength(0);
  });

  it("数据库拒绝同SH第二份QC和同QC重复收货行", async () => {
    const f = await fixture();
    const qc = await createQc(f.actor, f.input, db);
    await expect(db.insert(qcRecords).values({ shId: f.sh.id, createdBy: f.actor.id })).rejects.toThrow();
    await expect(db.insert(qcLines).values({ qcId: qc.id, shLineId: f.line.id, passQty: "0.3" })).rejects.toThrow();
    expect(await db.select().from(qcRecords).where(eq(qcRecords.shId, f.sh.id))).toHaveLength(1);
    expect(await db.select().from(qcLines).where(eq(qcLines.qcId, qc.id))).toHaveLength(1);
  });

  it("审计失败回滚QC头和行，原请求可以重新提交", async () => {
    const f = await fixture();
    await db.execute(sql`CREATE FUNCTION qc_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='qc' THEN RAISE EXCEPTION 'qc synthetic audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER qc_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qc_test_reject_audit()`);
    try {
      await expect(createQc(f.actor, f.input, db)).rejects.toThrow();
      expect(await db.select().from(qcRecords).where(eq(qcRecords.shId, f.sh.id))).toHaveLength(0);
      expect(await db.select().from(qcLines).where(eq(qcLines.shLineId, f.line.id))).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER qc_test_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION qc_test_reject_audit()`);
    }
    const saved = await createQc(f.actor, f.input, db);
    expect(saved.lines[0]).toMatchObject({ passQty: "0.1000", failQty: "0.1000", concessionQty: "0.1000" });
  });
});
