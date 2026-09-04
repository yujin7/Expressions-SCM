import { beforeAll, describe, expect, it } from "vitest";
import { batchStocks, skus, spus, warehouses } from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";
import { expiryCheck } from "@/server/modules/replenish/expiry";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * R15 临期检查（v1 告警）：batch_stocks 参考层；
 * 阈值 = skus.nearExpiryDays ?? 90（逐 SKU 覆盖）；nearQty 含已过期，expiredQty 为其中小计（daysLeft≤0 与驾驶舱同边界）。
 */
describe("R15 临期/过期批次检查", () => {
  let db: TestDb;
  let skuA = 0; // 默认阈值 90
  let skuB = 0; // 覆盖阈值 30
  let w1 = 0;
  let w2 = 0;
  const today = todayShanghai();
  const addDays = (n: number): string => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const [a] = await db
      .insert(skus)
      .values({ code: "CP00001", name: "默认阈值品", spuId: spu.id, skuType: "finished", baseUom: "盒" })
      .returning();
    const [b] = await db
      .insert(skus)
      .values({ code: "CP00002", name: "短阈值品", spuId: spu.id, skuType: "finished", baseUom: "盒", nearExpiryDays: 30 })
      .returning();
    skuA = a.id;
    skuB = b.id;
    const [wh1] = await db
      .insert(warehouses)
      .values({ code: "W1", name: "成品仓1", kind: "finished", accountingMode: "realtime" })
      .returning();
    const [wh2] = await db
      .insert(warehouses)
      .values({ code: "W2", name: "成品仓2", kind: "finished", accountingMode: "realtime" })
      .returning();
    w1 = wh1.id;
    w2 = wh2.id;

    await db.insert(batchStocks).values([
      // A@W1：近效期 +10 天 5 件；已过期 −3 天 2 件；新鲜 +200 天 9 件；无效期不计；0 数量不计
      { skuId: skuA, warehouseId: w1, batchNo: "A1", expiryDate: addDays(10), qty: "5", stocktakeDate: today },
      { skuId: skuA, warehouseId: w1, batchNo: "A2", expiryDate: addDays(-3), qty: "2", stocktakeDate: today },
      { skuId: skuA, warehouseId: w1, batchNo: "A3", expiryDate: addDays(200), qty: "9", stocktakeDate: today },
      { skuId: skuA, warehouseId: w1, batchNo: "A4", expiryDate: null, qty: "7", stocktakeDate: today },
      { skuId: skuA, warehouseId: w1, batchNo: "A5", expiryDate: addDays(5), qty: "0", stocktakeDate: today },
      // A@W2：+5 天 4 件（仓过滤用）
      { skuId: skuA, warehouseId: w2, batchNo: "A6", expiryDate: addDays(5), qty: "4", stocktakeDate: today },
      // B（阈值 30）：+40 天不近效；+20 天近效；+90 天在默认阈值内但 B 阈值外
      { skuId: skuB, warehouseId: w1, batchNo: "B1", expiryDate: addDays(40), qty: "6", stocktakeDate: today },
      { skuId: skuB, warehouseId: w1, batchNo: "B2", expiryDate: addDays(20), qty: "3", stocktakeDate: today },
      { skuId: skuB, warehouseId: w1, batchNo: "B3", expiryDate: addDays(90), qty: "11", stocktakeDate: today },
    ]);
  });

  it("指定仓库：near/expired/fresh 分类与逐 SKU 阈值覆盖", async () => {
    const res = await expiryCheck({ skuIds: [skuA, skuB], warehouseId: w1 }, db);
    expect(res.warehouseId).toBe(w1);
    const a = res.items.find((i) => i.skuId === skuA)!;
    expect(a.skuCode).toBe("CP00001");
    expect(a.thresholdDays).toBe(90);
    expect(a.nearQty).toBe(7); // 5 近效 + 2 已过期（含过期口径）
    expect(a.nearBatches).toBe(2);
    expect(a.expiredQty).toBe(2);
    expect(a.minDaysLeft).toBe(-3);

    const b = res.items.find((i) => i.skuId === skuB)!;
    expect(b.thresholdDays).toBe(30); // 逐 SKU 覆盖：40/90 天批次均不算近效
    expect(b.nearQty).toBe(3);
    expect(b.nearBatches).toBe(1);
    expect(b.expiredQty).toBe(0);
    expect(b.minDaysLeft).toBe(20);
  });

  it("省略仓库=全仓合并；未知 SKU 返回零值", async () => {
    const res = await expiryCheck({ skuIds: [skuA, 99999] }, db);
    const a = res.items.find((i) => i.skuId === skuA)!;
    expect(a.nearQty).toBe(11); // W1 的 7 + W2 的 4
    expect(a.nearBatches).toBe(3);
    expect(a.expiredQty).toBe(2);
    expect(a.minDaysLeft).toBe(-3);

    const unknown = res.items.find((i) => i.skuId === 99999)!;
    expect(unknown.skuCode).toBe("#99999");
    expect(unknown.nearQty).toBe(0);
    expect(unknown.nearBatches).toBe(0);
    expect(unknown.minDaysLeft).toBeNull();
  });

  it("空 skuIds 直接返回空 items", async () => {
    const res = await expiryCheck({ skuIds: [] }, db);
    expect(res.items).toEqual([]);
  });
});

/**
 * 分批调用时的盘点期收口：expiryCheck 被 inventory-alerts 每 200 个 SKU 调一次，
 * 若"各仓最新盘点期"只从本批 rows 推断，该仓最新期里没有本批 SKU 时就会退到旧期——
 * 旧期的批次被当成在库临期量报出来。最新期必须整表取。
 */
describe("R15 临期检查：最新盘点期按整表取，不受本批 SKU 影响", () => {
  it("同仓两期并存、且最新期只有别的 SKU 时，被查 SKU 不得回落到旧期", async () => {
    const { db } = await createTestDb();
    const today = todayShanghai();
    const day = (n: number): string => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const [spu] = await db.insert(spus).values({ code: "P-ST", nameCn: "盘点期" }).returning();
    const [target] = await db.insert(skus).values({ code: "ST-TARGET", name: "被查", spuId: spu.id, baseUom: "盒", skuType: "finished" }).returning();
    const [other] = await db.insert(skus).values({ code: "ST-OTHER", name: "同仓另一个", spuId: spu.id, baseUom: "盒", skuType: "finished" }).returning();
    const [wh] = await db.insert(warehouses).values({ code: "W-ST", name: "盘点仓", kind: "snapshot", accountingMode: "snapshot" }).returning();

    const oldPeriod = day(-30);
    const newPeriod = day(-1);
    await db.insert(batchStocks).values([
      // 旧期：被查 SKU 有一批临期货
      { skuId: target.id, warehouseId: wh.id, batchNo: "OLD", expiryDate: day(10), qty: "50", stocktakeDate: oldPeriod },
      // 最新期：只盘到了另一个 SKU（被查 SKU 这期已清零/未盘到）
      { skuId: other.id, warehouseId: wh.id, batchNo: "NEW", expiryDate: day(10), qty: "7", stocktakeDate: newPeriod },
    ]);

    // 只查 target（模拟分批：这一批里没有 other）
    const res = await expiryCheck({ skuIds: [target.id] }, db);
    const item = res.items.find((i) => i.skuId === target.id);
    // 该仓最新期是 newPeriod，target 在该期没有批次 → 不应报出旧期的 50
    expect(item?.nearQty ?? 0).toBe(0);
    expect(item?.nearBatches ?? 0).toBe(0);
  });
});
