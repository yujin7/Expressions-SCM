/** E6-P3 SKU 速览摘要（hovercard 数据源）——口径必须与 core/supply、core/velocity 一致 */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { batchStocks, skuParams, skus, spus, stockBalances, stockSnapshots, salesMonthly, warehouses, channels } from "@/db/schema";
import { getSkuBrief } from "@/server/modules/master/sku-brief";
import { ApiError } from "@/server/modules/master/common";

describe("getSkuBrief", () => {
  let db: TestDb;
  let skuA = 0; // 有库存+销量+效期
  let skuB = 0; // 有库存无销量（无动销）

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "P9", nameCn: "速览测试产品" }).returning();
    const mk = async (code: string, name: string) => {
      const [s] = await db.insert(skus).values({
        code,
        name,
        spuId: spu.id,
        skuType: "finished",
        baseUom: "件",
        nearExpiryDays: code === "BRIEF-A" ? 180 : null,
      }).returning();
      return s.id;
    };
    skuA = await mk("BRIEF-A", "速览甲");
    skuB = await mk("BRIEF-B", "速览乙");

    const [whReal] = await db
      .insert(warehouses)
      .values({ code: "BW-R", name: "实时仓", kind: "finished", accountingMode: "realtime" })
      .returning();
    const [whSnap] = await db
      .insert(warehouses)
      .values({ code: "BW-S", name: "快照仓", kind: "snapshot", accountingMode: "snapshot" })
      .returning();

    // 实时账 100
    await db.insert(stockBalances).values({ skuId: skuA, warehouseId: whReal.id, qty: "100" });
    // 快照：旧 40（不计） + 最新 50（计入）
    await db.insert(stockSnapshots).values([
      { skuId: skuA, warehouseId: whSnap.id, qty: "40", bizDate: "2026-07-01" },
      { skuId: skuA, warehouseId: whSnap.id, qty: "50", bizDate: "2026-07-10" },
    ]);
    await db.insert(stockBalances).values({ skuId: skuB, warehouseId: whReal.id, qty: "30" });

    // 销量：近 3 月合计 910 → 日均 10（÷91，core/velocity 唯一口径）
    const [ch] = await db.insert(channels).values({ code: "TM", name: "天猫", kind: "platform" }).returning();
    await db.insert(salesMonthly).values([
      { skuId: skuA, channelId: ch.id, yearMonth: "2026-04", qty: "300" },
      { skuId: skuA, channelId: ch.id, yearMonth: "2026-05", qty: "300" },
      { skuId: skuA, channelId: ch.id, yearMonth: "2026-06", qty: "310" },
    ]);

    // 效期批次：一批已过期
    await db.insert(batchStocks).values({
      skuId: skuA, warehouseId: whReal.id, qty: "10",
      expiryDate: "2020-01-01", stocktakeDate: "2026-07-01",
    });

    await db.insert(skuParams).values({ skuId: skuA, normalLeadDays: 45 });
  });

  it("在库=实时账+最新快照（旧快照不计）", async () => {
    const b = await getSkuBrief(skuA, db);
    expect(b.onHand).toBe(150); // 100 + 50，不含旧快照 40
    expect(b.code).toBe("BRIEF-A");
  });

  it("日均走 core/velocity 唯一口径（910/91=10），可销天数=在库/日均", async () => {
    const b = await getSkuBrief(skuA, db);
    expect(b.daily).toBeCloseTo(10, 4);
    expect(b.daysCover).toBeCloseTo(15, 1); // 150/10
  });

  it("无动销 → daysCover 为 null（不做 0 除）", async () => {
    const b = await getSkuBrief(skuB, db);
    expect(b.daily).toBe(0);
    expect(b.daysCover).toBeNull();
  });

  it("最短剩余效期为负（已过期）", async () => {
    const b = await getSkuBrief(skuA, db);
    expect(b.minDaysLeft).not.toBeNull();
    expect(b.minDaysLeft!).toBeLessThan(0);
  });

  it("临期阈值透传逐 SKU 值，未维护时回落 90 天", async () => {
    expect((await getSkuBrief(skuA, db)).nearExpiryDays).toBe(180);
    expect((await getSkuBrief(skuB, db)).nearExpiryDays).toBe(90);
  });

  it("生产周期取 sku_params；未维护为 null", async () => {
    expect((await getSkuBrief(skuA, db)).leadDays).toBe(45);
    expect((await getSkuBrief(skuB, db)).leadDays).toBeNull();
  });

  it("按编码查询等价于按 id 查询", async () => {
    const byCode = await getSkuBrief("BRIEF-A", db);
    const byId = await getSkuBrief(skuA, db);
    expect(byCode.skuId).toBe(byId.skuId);
  });

  it("无未结供给时 openSupply=0（core/supply 口径）", async () => {
    expect((await getSkuBrief(skuA, db)).openSupply).toBe(0);
  });

  it("spark 返回近 6 月序列且按月升序", async () => {
    const b = await getSkuBrief(skuA, db);
    expect(b.spark.length).toBeGreaterThan(0);
    const months = b.spark.map((p) => p.ym);
    expect([...months].sort()).toEqual(months);
  });

  it("SKU 不存在抛 404", async () => {
    await expect(getSkuBrief("NO-SUCH-SKU", db)).rejects.toThrow(ApiError);
  });
});
