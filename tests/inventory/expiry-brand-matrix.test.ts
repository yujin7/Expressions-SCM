/**
 * 效期批次「段位 × 品牌」矩阵与品牌筛选（BI-R3，指标 expiryByBrand）：
 * 矩阵在段位/搜索/品牌筛选之前、仓库筛选之后统计；无品牌归「(未设品牌)」；
 * 品牌筛选只影响明细行与 total，不影响矩阵与 bucketCounts。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { EXPIRY_NO_BRAND, listExpiryBatches } from "@/server/modules/inventory/expiry-list";
import { todayShanghai } from "@/server/modules/master/common";

function plusDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

describe("效期批次 · 段位 × 品牌矩阵", () => {
  it("矩阵按品牌聚合七段位；品牌筛选只裁剪明细；无品牌归入固定桶", async () => {
    const { db, client } = await createTestDb();
    try {
      const today = todayShanghai();
      const [ning] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P-EXP", nameCn: "效期测试" }).returning();
      const [s1] = await db.insert(schema.skus).values({ code: "EXP-N1", name: "有品牌", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: ning.id }).returning();
      const [s2] = await db.insert(schema.skus).values({ code: "EXP-X1", name: "无品牌", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
      const [wh1] = await db.insert(schema.warehouses).values({ code: "W1", name: "总仓", kind: "finished", accountingMode: "realtime", active: true }).returning();
      const [wh2] = await db.insert(schema.warehouses).values({ code: "W2", name: "云仓", kind: "snapshot", accountingMode: "snapshot", active: true }).returning();
      await db.insert(schema.batchStocks).values([
        { skuId: s1.id, warehouseId: wh1.id, batchNo: "A", expiryDate: plusDays(today, -5), qty: "10.0000", stocktakeDate: today },
        { skuId: s1.id, warehouseId: wh1.id, batchNo: "B", expiryDate: plusDays(today, 30), qty: "20.0000", stocktakeDate: today },
        { skuId: s1.id, warehouseId: wh2.id, batchNo: "C", expiryDate: plusDays(today, 400), qty: "7.0000", stocktakeDate: today },
        { skuId: s2.id, warehouseId: wh1.id, batchNo: "D", expiryDate: plusDays(today, 30), qty: "3.0000", stocktakeDate: today },
        { skuId: s2.id, warehouseId: wh1.id, batchNo: "E", expiryDate: plusDays(today, 1000), qty: "0.0000", stocktakeDate: today }, // qty 0 不计
      ]);

      const all = await listExpiryBatches({ bucket: "" }, db);
      expect(all.brands).toEqual(["NING", EXPIRY_NO_BRAND]);
      const ningRow = all.brandMatrix.find((r) => r.brand === "NING")!;
      expect(ningRow).toMatchObject({ batches: 3, qty: 37 });
      expect(ningRow.buckets.expired).toEqual({ batches: 1, qty: 10 });
      expect(ningRow.buckets.m3).toEqual({ batches: 1, qty: 20 });
      expect(ningRow.buckets.m18).toEqual({ batches: 1, qty: 7 });
      expect(all.brandMatrix.find((r) => r.brand === EXPIRY_NO_BRAND)).toMatchObject({ batches: 1, qty: 3 });
      expect(all.total).toBe(4);
      expect(all.brand).toBeNull();

      // 品牌筛选：明细只剩该品牌，矩阵与段位计数不变
      const onlyNing = await listExpiryBatches({ bucket: "", brand: "NING" }, db);
      expect(onlyNing.total).toBe(3);
      expect(onlyNing.rows.every((r) => r.brand === "NING")).toBe(true);
      expect(onlyNing.brandMatrix).toEqual(all.brandMatrix);
      expect(onlyNing.bucketCounts).toEqual(all.bucketCounts);
      expect(onlyNing.brand).toBe("NING");

      const noBrand = await listExpiryBatches({ bucket: "m3", brand: EXPIRY_NO_BRAND }, db);
      expect(noBrand.rows.map((r) => r.batchNo)).toEqual(["D"]);

      // 仓库筛选在矩阵之前生效
      const cloud = await listExpiryBatches({ bucket: "", warehouseId: wh2.id }, db);
      expect(cloud.brandMatrix).toEqual([{ brand: "NING", buckets: expect.objectContaining({ m18: { batches: 1, qty: 7 } }), batches: 1, qty: 7 }]);
    } finally {
      await client.close();
    }
  });
});
