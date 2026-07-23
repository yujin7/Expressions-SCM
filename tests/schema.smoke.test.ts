import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/db";
import { skus, spus, stockBalances, warehouses } from "@/db/schema";

describe("schema smoke", () => {
  it("applies migrations and enforces balance uniqueness (NULLS NOT DISTINCT)", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "BC00001", spuId: spu.id, baseUom: "个", skuType: "packaging", lossCategory: "packaging",
    }).returning();
    const [wh] = await db.insert(warehouses).values({ code: "WH1", name: "包材仓", kind: "packaging" }).returning();

    await db.insert(stockBalances).values({ skuId: sku.id, warehouseId: wh.id, batchId: null, qty: "10" });
    await expect(
      db.insert(stockBalances).values({ skuId: sku.id, warehouseId: wh.id, batchId: null, qty: "5" }),
    ).rejects.toThrow(); // NULL 批次不允许重复行
  });
});
