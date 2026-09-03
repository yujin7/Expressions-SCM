/**
 * D57/D60 调拨建议（report/transfer-suggest.ts）：缺口线消费 rules/alert-threshold（逐 SKU 加工+在途+缓冲），
 * 行上带 basis/usedDefault；结果按线路 (from,to) 分组只读汇总；skuIds 深链过滤。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { skuParams, skus, spus, stockBalances, stockLedger, users, warehouses } from "@/db/schema";
import { getTransferSuggestions } from "@/server/modules/report/transfer-suggest";
import { createTestDb, type TestDb } from "../helpers/db";

describe("transfer-suggest：阈值来源与线路分组", () => {
  let db: TestDb;
  let whA: number;
  let whB: number;
  let skuWithParams: number;
  let skuNoParams: number;
  let seq = 0;

  async function outflow(skuId: number, warehouseId: number, qty: string): Promise<void> {
    seq += 1;
    await db.insert(stockLedger).values({
      skuId, warehouseId, batchId: null, qtyDelta: `-${qty}`,
      sourceDocType: "test_out", sourceDocId: seq, action: "post", occurredAt: new Date(Date.now() - 3 * 86_400_000),
    });
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values({ name: "建议测试", roles: ["pmc"] });
    const [a] = await db.insert(warehouses).values({ code: "TS-A", name: "盈余仓", kind: "finished" }).returning();
    const [b] = await db.insert(warehouses).values({ code: "TS-B", name: "缺口仓", kind: "finished" }).returning();
    whA = a.id; whB = b.id;
    const [spu] = await db.insert(spus).values({ code: "PTS01", nameCn: "建议品" }).returning();
    const [s1] = await db.insert(skus).values({ code: "TS001", name: "有参数SKU", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    const [s2] = await db.insert(skus).values({ code: "TS002", name: "无参数SKU", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    skuWithParams = s1.id; skuNoParams = s2.id;
    // SKU1：加工 10 + 在途 5 + 缓冲(默认 5) = 20 天；SKU2 无参数 → 30 + 15 + 5 = 50 天（按默认周期）
    await db.insert(skuParams).values({ skuId: skuWithParams, normalLeadDays: 10, logisticsLeadDays: 5 });
    for (const skuId of [skuWithParams, skuNoParams]) {
      // 盈余仓：在库 10000、90 天出库 90 → 可销 10000 天 > 盈余线；缺口仓：在库 10、出库 90 → 可销 10 天 < 阈值
      await db.insert(stockBalances).values({ skuId, warehouseId: whA, batchId: null, qty: "10000" });
      await db.insert(stockBalances).values({ skuId, warehouseId: whB, batchId: null, qty: "10" });
      await outflow(skuId, whA, "90");
      await outflow(skuId, whB, "90");
    }
  });

  it("逐 SKU 阈值：有 sku_params 的按参数、无参数的落默认并标 usedDefault；线路汇总一条 A→B", async () => {
    const res = await getTransferSuggestions({ horizonDays: 90 }, db);
    expect(res.total).toBe(2);
    const r1 = res.rows.find((r) => r.skuId === skuWithParams)!;
    const r2 = res.rows.find((r) => r.skuId === skuNoParams)!;
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1.alertDays).toBe(20);
    expect(r1.usedDefault).toBe(false);
    expect(r1.basis.find((b) => b.part === "production")).toMatchObject({ value: 10, source: "sku_params" });
    expect(r1.basis.find((b) => b.part === "logistics")).toMatchObject({ value: 5, source: "sku_params" });
    expect(r2.alertDays).toBe(50);
    expect(r2.usedDefault).toBe(true);
    expect(r2.basis.some((b) => b.source === "default")).toBe(true);
    expect(r2.reason).toContain("按默认周期");
    expect(r1.reason).not.toContain("按默认周期");
    expect(r1.qty).toBeGreaterThan(0);
    expect(r1.fromWarehouseId).toBe(whA);
    expect(r1.toWarehouseId).toBe(whB);

    expect(res.lanes).toHaveLength(1);
    expect(res.lanes[0]).toMatchObject({ fromWarehouseId: whA, toWarehouseId: whB, fromWarehouse: "盈余仓", toWarehouse: "缺口仓", lineCount: 2, skuCount: 2 });
    expect(res.lanes[0].totalQty).toBe(res.summary.totalQty);
    expect(res.summary.usedDefaultCount).toBe(1);
    expect(res.summary.thresholdDefaults).toEqual({ production: 30, logistics: 15, buffer: 5 });
    expect(res.summary.skuIdsFilter).toBeNull();
  });

  it("skuIds 深链只算指定 SKU；非法 id 被剔除", async () => {
    const res = await getTransferSuggestions({ horizonDays: 90, skuIds: [skuWithParams, 0, -1, skuWithParams] }, db);
    expect(res.summary.skuIdsFilter).toEqual([skuWithParams]);
    expect(res.total).toBe(1);
    expect(res.rows[0].skuId).toBe(skuWithParams);
    expect(res.lanes[0].lineCount).toBe(1);
  });
});
