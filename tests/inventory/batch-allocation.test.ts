import { beforeEach, describe, expect, it } from "vitest";
import {
  batches, skus, spus, stockBalances, sysParams, warehouses,
} from "@/db/schema";
import { expandOutboundLinesForBatchPosting } from "@/server/modules/inventory/batch-allocation";
import { createTestDb, type TestDb } from "../helpers/db";

describe("批次过账迁移闸门与 FEFO 行展开", () => {
  let db: TestDb;
  let skuId = 0;
  let warehouseId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "BA-SPU", nameCn: "批次测试" }).returning();
    const [sku] = await db.insert(skus).values({
      spuId: spu.id,
      code: "BA-SKU",
      name: "批次测试 SKU",
      skuType: "finished",
      baseUom: "个",
    }).returning();
    skuId = sku.id;
    const [warehouse] = await db.insert(warehouses).values({
      code: "BA-WH",
      name: "批次测试仓",
      kind: "finished",
      accountingMode: "realtime",
    }).returning();
    warehouseId = warehouse.id;
  });

  it("闸门关闭时不改变现有无批次单行", async () => {
    const lines = await expandOutboundLinesForBatchPosting(db, warehouseId, [
      { skuId, qty: "10", marker: "legacy" },
    ]);
    expect(lines).toEqual([{ skuId, qty: "10.0000", batchId: null, marker: "legacy" }]);
  });

  it.each(["return", "reviewed_scrap"] as const)("%s 仅允许明确批次退回/报废，不绕过身份或数量，也不自动推荐过期货", async purpose => {
    await db.insert(sysParams).values({ scope: "global", key: "batch_posting_enabled", value: "1" });
    const [batch] = await db.insert(batches).values({ skuId, batchNo: "EXPIRED-RETURN", expiryDate: "2000-01-01" }).returning();
    await db.insert(stockBalances).values({ skuId, warehouseId, batchId: batch.id, qty: "2" });
    const lines = [{ skuId, qty: "1", batchId: batch.id }];
    await expect(expandOutboundLinesForBatchPosting(db, warehouseId, lines)).rejects.toMatchObject({ status: 409 });
    expect(await expandOutboundLinesForBatchPosting(db, warehouseId, lines, purpose)).toEqual([{ ...lines[0], qty: "1.0000" }]);
    await expect(expandOutboundLinesForBatchPosting(db, warehouseId, [{ ...lines[0], qty: "3" }], purpose)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("批次库存不足") });
    await expect(expandOutboundLinesForBatchPosting(db, warehouseId, [{ ...lines[0], skuId: skuId + 999 }], purpose)).rejects.toMatchObject({ status: 400 });
    await expect(expandOutboundLinesForBatchPosting(db, warehouseId, [{ skuId, qty: "1" }], purpose)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("过期批次") });
  });

  it("闸门开启后按 FEFO 拆行并保持原业务行归属", async () => {
    await db.insert(sysParams).values({
      scope: "global", key: "batch_posting_enabled", value: "1",
    });
    const inserted = await db.insert(batches).values([
      { skuId, batchNo: "EARLY", expiryDate: "2027-01-01" },
      { skuId, batchNo: "LATE", expiryDate: "2027-12-01" },
    ]).returning();
    await db.insert(stockBalances).values([
      { skuId, warehouseId, batchId: inserted[0].id, qty: "6" },
      { skuId, warehouseId, batchId: inserted[1].id, qty: "20" },
    ]);

    const lines = await expandOutboundLinesForBatchPosting(db, warehouseId, [
      { skuId, qty: "8", marker: "A" },
      { skuId, qty: "5", marker: "B" },
    ]);
    expect(lines).toEqual([
      { skuId, qty: "6.0000", batchId: inserted[0].id, marker: "A" },
      { skuId, qty: "2.0000", batchId: inserted[1].id, marker: "A" },
      { skuId, qty: "5.0000", batchId: inserted[1].id, marker: "B" },
    ]);
  });

  it("过期批次不计入可发库存，缺口直接阻断建单", async () => {
    await db.insert(sysParams).values({
      scope: "global", key: "batch_posting_enabled", value: "1",
    });
    const [expired] = await db.insert(batches).values({
      skuId, batchNo: "EXPIRED", expiryDate: "2026-01-01",
    }).returning();
    await db.insert(stockBalances).values({
      skuId, warehouseId, batchId: expired.id, qty: "100",
    });

    await expect(expandOutboundLinesForBatchPosting(db, warehouseId, [
      { skuId, qty: "1" },
    ])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("已排除过期批次"),
    });
  });

  it("显式批次校验 SKU 归属和批次余额", async () => {
    await db.insert(sysParams).values({
      scope: "global", key: "batch_posting_enabled", value: "1",
    });
    const [batch] = await db.insert(batches).values({
      skuId, batchNo: "EXPLICIT", expiryDate: "2027-01-01",
    }).returning();
    await db.insert(stockBalances).values({
      skuId, warehouseId, batchId: batch.id, qty: "2",
    });

    await expect(expandOutboundLinesForBatchPosting(db, warehouseId, [
      { skuId, qty: "3", batchId: batch.id },
    ])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("批次库存不足"),
    });
  });
});
