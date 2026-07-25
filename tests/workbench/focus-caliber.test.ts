import { beforeEach, describe, expect, it } from "vitest";
import { channels, salesMonthly, skuParams, skus, spus, stockBalances, stockSnapshots, warehouses } from "@/db/schema";
import { computeExceptions } from "@/server/modules/workbench/focus";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 控制塔首屏「断货风险」的在库口径护栏。
 *
 * 这条测试守的是一个真实缺陷：`computeExceptions` 里曾内联
 * `sum(qty) from stock_balances` 自己算在库，**只看实时记账仓、看不见快照仓**
 * （保税/E仓/云仓）。真实数据上 261 条断货告警里只有 111 条是真的，
 * 另外 150 个成品其实货在快照仓里躺着——DEV007-000 本地读到 237 件，
 * 全网实际 14,966 件，差 63 倍。
 *
 * 首屏是用户最先看到、也最容易据此下单的地方，这个数错了代价最大。
 * 因此这里用「货全在快照仓」的极端场景钉住口径：**必须走 core/stock-view**。
 */
describe("控制塔首屏：断货风险必须用全网在库口径", () => {
  let db: TestDb;
  let realtimeWh = 0;
  let snapshotWh = 0;
  let channelId = 0;

  const mkSku = async (code: string): Promise<number> => {
    const [spu] = await db.insert(spus).values({ code: `SPU-${code}`, nameCn: code }).returning();
    const [s] = await db
      .insert(skus)
      .values({ spuId: spu.id, code, name: code, skuType: "finished", baseUom: "个", active: true })
      .returning();
    // 生产周期 50 天：可销 <50 天即判断货风险
    await db.insert(skuParams).values({ skuId: s.id, normalLeadDays: 50 });
    return s.id;
  };
  /** 近三月各 300 件 → 日均 900/91 ≈ 9.89 件/天；50 天需 ≈495 件 */
  const mkSales = async (skuId: number) => {
    for (const ym of ["2026-04", "2026-05", "2026-06"]) {
      await db.insert(salesMonthly).values({ skuId, channelId, yearMonth: ym, qty: "300" });
    }
  };

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [rt] = await db.insert(warehouses).values({ code: "RT", name: "实时仓", kind: "finished" }).returning();
    const [sn] = await db.insert(warehouses).values({ code: "SN", name: "保税仓", kind: "snapshot" }).returning();
    realtimeWh = rt.id;
    snapshotWh = sn.id;
    const [ch] = await db.insert(channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
    channelId = ch.id;
  });

  const belowLeadCount = async (): Promise<number> =>
    (await computeExceptions(db)).find((i) => i.key === "below_lead")?.count ?? 0;

  it("**货在快照仓里就不算断货**——只看 stock_balances 会误报", async () => {
    const skuId = await mkSku("SNAP-ONLY");
    await mkSales(skuId);
    // 实时仓 0 件，快照仓 5,000 件（远超 50 天所需的 ~495 件）
    await db.insert(stockSnapshots).values({ warehouseId: snapshotWh, skuId, bizDate: "2026-07-21", qty: "5000" });

    expect(await belowLeadCount()).toBe(0); // 旧口径会把它算成断货
  });

  it("真的没货时仍然要报——护栏不能把告警一并抹掉", async () => {
    const skuId = await mkSku("REALLY-SHORT");
    await mkSales(skuId);
    await db.insert(stockBalances).values({ skuId, warehouseId: realtimeWh, batchId: null, qty: "10" });

    expect(await belowLeadCount()).toBe(1);
  });

  it("实时仓 + 快照仓合并计算（两边单看都不够、合起来够 → 不报）", async () => {
    const skuId = await mkSku("MERGED");
    await mkSales(skuId);
    // 判据已于 2026-07-26 改为「引擎给得出建议量」(suggestQty != null)，
    // 而引擎是按**跌破安全库存**判短缺，不是裸的「可销 < 生产周期」。
    // 本例安全库存实测 348 件（近6月窗口里前三月无销量，σ 偏大），
    // 故合并量必须同时盖过 50 天消耗(≈495) **与** 安全库存，才是真的「不缺」。
    // 各 700 件：单看 700 < 495+348=843（仍不足），合并 1400 才够——
    // 继续钉住「快照仓必须计入」这条口径。
    await db.insert(stockBalances).values({ skuId, warehouseId: realtimeWh, batchId: null, qty: "700" });
    await db.insert(stockSnapshots).values({ warehouseId: snapshotWh, skuId, bizDate: "2026-07-21", qty: "700" });

    expect(await belowLeadCount()).toBe(0);
  });

  it("impact 文案标明全网口径与快照时点（用户要知道数字从哪来）", async () => {
    const skuId = await mkSku("SHORT-2");
    await mkSales(skuId);
    await db.insert(stockSnapshots).values({ warehouseId: snapshotWh, skuId, bizDate: "2026-07-21", qty: "1" });

    const item = (await computeExceptions(db)).find((i) => i.key === "below_lead");
    expect(item?.impact).toContain("全网口径");
    expect(item?.impact).toContain("2026-07-21");
  });

  it("无销量或无生产周期的成品不参与判定（避免 0 除与噪音）", async () => {
    const noSales = await mkSku("NO-SALES"); // 无 sales_monthly
    await db.insert(stockBalances).values({ skuId: noSales, warehouseId: realtimeWh, batchId: null, qty: "0" });

    expect(await belowLeadCount()).toBe(0);
  });
});
