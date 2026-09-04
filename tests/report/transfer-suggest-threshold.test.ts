/**
 * D57/D60 调拨建议（report/transfer-suggest.ts）：缺口线消费 rules/alert-threshold（逐 SKU 加工+在途+缓冲），
 * 行上带 basis/usedDefault；结果按线路 (from,to) 分组只读汇总；skuIds 深链过滤。
 * W4：批次效期——临期仓优先让出、已过期数量绝不进建议（expiredHeld 单列）、按 FEFO 给出会动到的批次。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { batchStocks, skuParams, skus, spus, stockBalances, stockLedger, users, warehouses } from "@/db/schema";
import { getTransferSuggestions } from "@/server/modules/report/transfer-suggest";
import { todayShanghai } from "@/server/modules/master/common";
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

describe("transfer-suggest：W4 效期意识（临期先挪 / 过期不挪 / FEFO 批次）", () => {
  let db: TestDb;
  let whNear: number; // 盈余仓：压着临期批次
  let whFar: number; // 盈余仓：量更大但无效期信息
  let whShort: number; // 缺口仓
  let skuNear = 0; // 临期驱动
  let skuExpired = 0; // 调出仓库存几乎全过期 → 不可作调出仓
  let seq = 100;
  const today = todayShanghai();
  const shift = (days: number): string => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  async function outflow(skuId: number, warehouseId: number, qty: string): Promise<void> {
    seq += 1;
    await db.insert(stockLedger).values({
      skuId, warehouseId, batchId: null, qtyDelta: `-${qty}`,
      sourceDocType: "test_out", sourceDocId: seq, action: "post", occurredAt: new Date(Date.now() - 3 * 86_400_000),
    });
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values({ name: "效期测试", roles: ["pmc"] });
    const [a] = await db.insert(warehouses).values({ code: "TX-A", name: "临期盈余仓", kind: "finished" }).returning();
    const [b] = await db.insert(warehouses).values({ code: "TX-B", name: "大盈余仓", kind: "finished" }).returning();
    const [c] = await db.insert(warehouses).values({ code: "TX-C", name: "缺口仓", kind: "finished" }).returning();
    whNear = a.id; whFar = b.id; whShort = c.id;
    const [spu] = await db.insert(spus).values({ code: "PTX01", nameCn: "效期品" }).returning();
    const [s1] = await db.insert(skus).values({ code: "TX001", name: "临期SKU", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    const [s2] = await db.insert(skus).values({ code: "TX002", name: "过期SKU", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    skuNear = s1.id; skuExpired = s2.id;
    // 阈值 = 加工 10 + 在途 5 + 缓冲 5 = 20 天；盈余线 = 目标 45×2 = 90 天
    await db.insert(skuParams).values([
      { skuId: skuNear, normalLeadDays: 10, logisticsLeadDays: 5 },
      { skuId: skuExpired, normalLeadDays: 10, logisticsLeadDays: 5 },
    ]);
    for (const skuId of [skuNear, skuExpired]) {
      await db.insert(stockBalances).values([
        { skuId, warehouseId: whNear, batchId: null, qty: "1000" },
        { skuId, warehouseId: whFar, batchId: null, qty: "5000" },
        { skuId, warehouseId: whShort, batchId: null, qty: "10" },
      ]);
      // 三仓近 90 天各出库 90 → 日均 1；缺口仓可销 10 天 < 20 天阈值
      await outflow(skuId, whNear, "90");
      await outflow(skuId, whFar, "90");
      await outflow(skuId, whShort, "90");
    }
    await db.insert(batchStocks).values([
      // TX001 临期仓：200 已过期（不可调拨）+ 500 剩 30 天（临期）+ 300 剩 400 天
      { skuId: skuNear, warehouseId: whNear, batchNo: "N-EXPIRED", expiryDate: shift(-5), qty: "200", stocktakeDate: today },
      { skuId: skuNear, warehouseId: whNear, batchNo: "N-NEAR", expiryDate: shift(30), qty: "500", stocktakeDate: today },
      { skuId: skuNear, warehouseId: whNear, batchNo: "N-FAR", expiryDate: shift(400), qty: "300", stocktakeDate: today },
      // TX002 临期仓：990 已过期 → 可用在库仅 10，扣自留缓冲后无可让出量
      { skuId: skuExpired, warehouseId: whNear, batchNo: "E-EXPIRED", expiryDate: shift(-1), qty: "990", stocktakeDate: today },
      { skuId: skuExpired, warehouseId: whNear, batchNo: "E-OK", expiryDate: shift(400), qty: "10", stocktakeDate: today },
    ]);
  });

  it("临期仓优先让出，行上给出 FEFO 批次、minDaysLeft 与已过期扣减", async () => {
    const res = await getTransferSuggestions({ horizonDays: 90, skuIds: [skuNear] }, db);
    expect(res.total).toBe(1);
    const r = res.rows[0];
    // 大盈余仓可让出 4980 远多于临期仓的 780，但临期仓压着 30 天到期的批次 → 先挪它
    expect(r.fromWarehouseId).toBe(whNear);
    expect(r.toWarehouseId).toBe(whShort);
    expect(r.qty).toBe(35); // 补到目标 45 天：1×45 − 10
    expect(r.expiryDriven).toBe(true);
    expect(r.minDaysLeft).toBe(30);
    expect(r.expiredHeld).toBe(200);
    // FEFO：已过期批次被排除，先动最近到期的未过期批次
    expect(r.fefoLots).toHaveLength(1);
    expect(r.fefoLots[0]).toMatchObject({ batchNo: "N-NEAR", expiryDate: shift(30) });
    expect(r.reason).toContain("临期批次");
    expect(r.reason).toContain("已过期");
    expect(res.summary.expiryDrivenCount).toBe(1);
    expect(res.summary.expiredHeldTotal).toBe(200);
    expect(res.summary.expiryToday).toBe(today);
  });

  it("已过期数量绝不参与调拨：库存几乎全过期的仓不再是调出仓", async () => {
    const res = await getTransferSuggestions({ horizonDays: 90, skuIds: [skuExpired] }, db);
    // 990/1000 过期 → 可用在库 10，扣 20 天自留缓冲后无可让出量；建议只能来自大盈余仓
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.every((r) => r.fromWarehouseId === whFar)).toBe(true);
    expect(res.rows.some((r) => r.toWarehouseId === whNear)).toBe(true); // 反而成了缺口仓（可卖库存只剩 10）
    expect(res.summary.expiryDrivenCount).toBe(0); // 调出仓（大盈余仓）无批次效期数据
  });
});
