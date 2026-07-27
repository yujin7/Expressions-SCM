import { beforeEach, describe, expect, it } from "vitest";
import { channels, salesMonthly, skuParams, skus, spus, stockBalances, stockSnapshots, warehouses } from "@/db/schema";
import { getSkuFacts, getSkuFactsFor } from "@/server/core/sku-facts";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * E8-01 SKU 事实服务。
 *
 * 唯一权威解决「同一个数怎么算」，本服务解决「同一组数怎么凑齐」——
 * 凑装配的过程本身会漂：控制塔曾内联 stock_balances 求和漏掉快照仓（261 vs 111），
 * sku-brief 的注释直接写着「照抄 replenish/service.ts 的 latestSnapshotRows 模式」。
 *
 * 这些用例钉住：装配必须走唯一权威（快照仓要算进来）、诚实降级（无动销不编可销天数）、
 * 以及批量与单条同源。
 */
describe("getSkuFacts 事实装配", () => {
  let db: TestDb;
  let rtWh = 0;
  let snapWh = 0;
  let channelId = 0;

  const mkSku = async (code: string, leadDays?: number): Promise<number> => {
    const [spu] = await db.insert(spus).values({ code: `SPU-${code}`, nameCn: code }).returning();
    const [s] = await db
      .insert(skus)
      .values({ spuId: spu.id, code, name: code, skuType: "finished", baseUom: "个", active: true })
      .returning();
    if (leadDays != null) await db.insert(skuParams).values({ skuId: s.id, normalLeadDays: leadDays });
    return s.id;
  };

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [rt] = await db.insert(warehouses).values({ code: "RT", name: "实时仓", kind: "finished" }).returning();
    const [sn] = await db.insert(warehouses).values({
      code: "SN",
      name: "保税仓",
      kind: "snapshot",
      accountingMode: "snapshot",
    }).returning();
    const [ch] = await db.insert(channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
    rtWh = rt.id; snapWh = sn.id; channelId = ch.id;
  });

  it("**在库合并快照仓**——装配层不得退化成只看实时账", async () => {
    const id = await mkSku("A1");
    await db.insert(stockBalances).values({ skuId: id, warehouseId: rtWh, batchId: null, qty: "100" });
    await db.insert(stockSnapshots).values({ warehouseId: snapWh, skuId: id, bizDate: "2026-07-21", qty: "400" });

    const v = await getSkuFacts(db, { skuIds: [id] });
    expect(v.bySku.get(id)!.onHand).toBe(500); // 只看实时账会得到 100
    expect(v.snapDate).toBe("2026-07-21"); // 数据龄必须随行，页面才能标注
  });

  it("日均走 core/velocity 的 3 月窗口 ÷91，可销天数由其推导", async () => {
    const id = await mkSku("A2");
    await db.insert(stockBalances).values({ skuId: id, warehouseId: rtWh, batchId: null, qty: "910" });
    for (const ym of ["2026-04", "2026-05", "2026-06"]) {
      await db.insert(salesMonthly).values({ skuId: id, channelId, yearMonth: ym, qty: "300" });
    }
    const f = (await getSkuFacts(db, { skuIds: [id] })).bySku.get(id)!;
    expect(f.daily).toBeCloseTo(900 / 91, 1);
    expect(f.daysCover).toBeCloseTo(910 / (900 / 91), 0);
  });

  it("**无动销时 daysCover = null**，不做 0 除也不假装是 0 天", async () => {
    const id = await mkSku("A3");
    await db.insert(stockBalances).values({ skuId: id, warehouseId: rtWh, batchId: null, qty: "50" });

    const f = (await getSkuFacts(db, { skuIds: [id] })).bySku.get(id)!;
    expect(f.daily).toBe(0);
    expect(f.daysCover).toBeNull();
  });

  it("生产周期未维护时为 null（不兜底成某个数字）", async () => {
    const withLead = await mkSku("A4", 45);
    const without = await mkSku("A5");
    const v = await getSkuFacts(db, { skuIds: [withLead, without] });
    expect(v.bySku.get(withLead)!.leadDays).toBe(45);
    expect(v.bySku.get(without)!.leadDays).toBeNull();
  });

  it("批量一次装配多个 SKU（列表页不得退化成逐行查询）", async () => {
    const ids = [await mkSku("B1"), await mkSku("B2"), await mkSku("B3")];
    for (const id of ids) await db.insert(stockBalances).values({ skuId: id, warehouseId: rtWh, batchId: null, qty: "7" });

    const v = await getSkuFacts(db, { skuIds: ids });
    expect(v.bySku.size).toBe(3);
    expect([...v.bySku.values()].every((f) => f.onHand === 7)).toBe(true);
  });

  it("单条入口与批量同源（不存在第二套装配）", async () => {
    const id = await mkSku("C1", 30);
    await db.insert(stockBalances).values({ skuId: id, warehouseId: rtWh, batchId: null, qty: "12" });

    const one = await getSkuFactsFor(db, id);
    const batch = (await getSkuFacts(db, { skuIds: [id] })).bySku.get(id);
    expect(one).toEqual(batch);
  });

  it("月度序列按窗口长度返回、升序、缺月补 0", async () => {
    const id = await mkSku("D1");
    await db.insert(salesMonthly).values({ skuId: id, channelId, yearMonth: "2026-06", qty: "5" });

    const f = (await getSkuFacts(db, { skuIds: [id], months: 3 })).bySku.get(id)!;
    expect(f.series).toHaveLength(3);
    expect(f.series.map((x) => x.ym)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(f.series.map((x) => x.qty)).toEqual([0, 0, 5]);
  });

  it("空 skuIds 直接返回空视图，不扫全表", async () => {
    const v = await getSkuFacts(db, { skuIds: [] });
    expect(v.bySku.size).toBe(0);
    expect(v.snapDate).toBeNull();
  });

  it("无销量数据时不抛错，月窗为空、日均为 0", async () => {
    const id = await mkSku("E1");
    const v = await getSkuFacts(db, { skuIds: [id] });
    expect(v.maxYm).toBeNull();
    expect(v.months).toEqual([]);
    expect(v.bySku.get(id)!.daily).toBe(0);
  });
});
