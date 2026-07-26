import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, skus, spus, suppliers } from "@/db/schema";
import type { DB } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { createFeeRef, listFeeRefs, updateFeeRef } from "@/server/modules/master/feeref";
import { createTestDb, type TestDb } from "../helpers/db";

describe("加工费参考价 feeref：CRUD + 脱敏 + 幂等约束", () => {
  let db: TestDb;
  let dbx: DB;
  let skuId = 0;
  let supA = 0;
  let supB = 0;
  const buyer = { id: 31, name: "采购" };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    dbx = db as unknown as DB;
    const [spu] = await db.insert(spus).values({ code: "PFR01", nameCn: "费用测试品" }).returning();
    const [s] = await db
      .insert(skus)
      .values({ code: "FR-P1", name: "费用成品", spuId: spu.id, baseUom: "个", skuType: "finished" })
      .returning();
    skuId = s.id;
    const [a] = await db.insert(suppliers).values({ code: "GFR1", name: "费用甲厂", kinds: ["processor"] }).returning();
    const [b] = await db.insert(suppliers).values({ code: "GFR2", name: "费用乙厂", kinds: ["processor"] }).returning();
    supA = a.id;
    supB = b.id;
  });

  it("创建：金额归一 scale=2；可空待补录；审计落行", async () => {
    const created = await createFeeRef(
      buyer,
      { skuId, supplierId: supA, feeRate: "12.345", effectiveDate: "2026-07-01", note: "首价" },
      dbx,
    );
    expect(created.feeRate).toBe("12.35"); // 半进位到分
    expect(created.source).toBe("manual");
    const empty = await createFeeRef(buyer, { skuId, supplierId: supB, effectiveDate: "2026-07-01" }, dbx);
    expect(empty.feeRate).toBeNull();
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "processing_fee_ref"), eq(auditLogs.action, "create")));
    expect(audits).toHaveLength(2);
  });

  it("列表：join SKU/供应商 + q/supplierId 过滤", async () => {
    const all = await listFeeRefs({ q: "", page: 1, pageSize: 10 }, dbx);
    expect(all.total).toBe(2);
    expect(all.data[0].skuCode).toBe("FR-P1");
    const byName = await listFeeRefs({ q: "乙厂", page: 1, pageSize: 10 }, dbx);
    expect(byName.total).toBe(1);
    expect(byName.data[0].supplierName).toBe("费用乙厂");
    const bySup = await listFeeRefs({ q: "", page: 1, pageSize: 10, supplierId: supA }, dbx);
    expect(bySup.total).toBe(1);
  });

  it("更新 feeRate/effectiveDate/note + 审计 before/after；不存在 404", async () => {
    const { data } = await listFeeRefs({ q: "乙厂", page: 1, pageSize: 10 }, dbx);
    const updated = await updateFeeRef(buyer, data[0].id, { feeRate: 8, effectiveDate: "2026-08-01", note: "补录" }, dbx);
    expect(updated.feeRate).toBe("8.00");
    expect(updated.effectiveDate).toBe("2026-08-01");
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "processing_fee_ref"), eq(auditLogs.action, "update")));
    expect(audits).toHaveLength(1);
    expect((audits[0].before as { feeRate: string | null }).feeRate).toBeNull();
    await expect(updateFeeRef(buyer, 999999, { feeRate: 1 }, dbx)).rejects.toThrow(/不存在/);
    await expect(updateFeeRef(buyer, data[0].id, { feeRate: -1 }, dbx)).rejects.toThrow();
  });

  it("R9 脱敏：仓管角色响应中 feeRate 键被剥离；采购可见", async () => {
    const res = await listFeeRefs({ q: "", page: 1, pageSize: 10 }, dbx);
    const masked = maskSensitive(res, ["warehouse"]);
    expect(masked.data.every((r) => !("feeRate" in r))).toBe(true);
    const visible = maskSensitive(res, ["purchasing"]);
    expect("feeRate" in visible.data[0]).toBe(true);
  });

  it("uq_fee_sku_sup_date：同 SKU+厂+生效日重复创建被拒", async () => {
    await expect(
      createFeeRef(buyer, { skuId, supplierId: supA, feeRate: 9, effectiveDate: "2026-07-01" }, dbx),
    ).rejects.toThrow();
  });
});
