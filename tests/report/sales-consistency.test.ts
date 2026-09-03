/**
 * 销量口径一致性读模型（sales_monthly vs 天猫观察，SKU × 完整月，三阈值）。
 * 钉住：只比较两侧都有数据的完整月；锚点月与观察首日非 1 号的头月（外部不完整）不比；
 * 内部缺月（外部完整但 sales_monthly 无记录）跳过、写进 skippedMonths、不记为不一致；单侧缺失=未覆盖不补 0；
 * 相对/绝对/量下限三阈值语义；缓存绑定随 sales_monthly 与批次变化失效。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import {
  computeSalesConsistency, judgeConsistency, loadSalesConsistency, monthsBetween, refreshSalesConsistency, SALES_CONSISTENCY_CACHE_KEY,
} from "@/server/modules/report/sales-consistency";

const T = { relPct: 10, absFloorQty: 5, minBaseQty: 10 };

async function seed() {
  const { db, client } = await createTestDb();
  const [actor] = await db.insert(schema.users).values({ name: "数据责任人", roles: ["pmc"] }).returning();
  const [tmall] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P90010", nameCn: "一致性测试" }).returning();
  const mk = async (code: string) => (await db.insert(schema.skus).values({ code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning())[0];
  const a = await mk("SC-A"); // 一致
  const b = await mk("SC-B"); // 例外
  const c = await mk("SC-C"); // 低于量下限
  const d = await mk("SC-D"); // 仅内部
  const jobs = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "cw", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_sales_observation", filename: "sales", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_refund_observation", filename: "refunds", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
  ]).returning();
  const [crosswalk, sales, refunds] = jobs;
  const finishedAt = new Date("2026-09-02T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "cw", status: "succeeded", importJobId: crosswalk.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "sales", status: "succeeded", importJobId: sales.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "refunds", status: "succeeded", importJobId: refunds.id, finishedAt },
  ]);
  const shop = "旗舰店";
  const cw = (rowNo: number, psku: string, skuId: number) => ({
    importJobId: crosswalk.id, rowNo, status: "pending" as const, targetTable: "jdy_tmall_sku_crosswalk_observation",
    payload: { data: { shopName: shop, platformSkuId: psku }, _identity: { skuId } },
  });
  const sale = (rowNo: number, psku: string, date: string, paid: string) => ({
    importJobId: sales.id, rowNo, status: "pending" as const, targetTable: "jdy_tmall_sku_sales_observation",
    payload: { data: { statisticalDate: date, shopName: shop, skuId: psku, paidNumber: paid } },
  });
  await db.insert(schema.stagingRows).values([
    cw(1, "P-A", a.id), cw(2, "P-B", b.id), cw(3, "P-C", c.id),
    // 2026-07：A 支付 105 − 退款 5 = 100；B 200；C 3；观察首日 07-01（头月完整）、锚点 2026-09-02 → 7/8 月完整、9 月不完整
    sale(1, "P-A", "2026-07-01", "60"), sale(2, "P-A", "2026-07-20", "45"),
    sale(3, "P-B", "2026-07-10", "200"),
    sale(4, "P-C", "2026-07-11", "3"),
    // 2026-08：A 50（内部无 8 月 → 仅外部）
    sale(5, "P-A", "2026-08-05", "50"),
    // 2026-09（锚点月，不比）
    sale(6, "P-A", "2026-09-02", "999"),
    { importJobId: refunds.id, rowNo: 1, status: "pending" as const, targetTable: "jdy_tmall_sku_refund_observation",
      payload: { data: { statisticalDate: "2026-07-25", shopName: shop, skuId: "P-A", successRefundSuborderNumber: "5" } } },
  ]);
  await db.insert(schema.salesMonthly).values([
    { skuId: a.id, channelId: tmall.id, yearMonth: "2026-07", qty: "108.0000" }, // 差 8 ≤ max(5, 10.8) → 一致
    { skuId: b.id, channelId: tmall.id, yearMonth: "2026-07", qty: "150.0000" }, // 差 50 > 20 → 例外
    { skuId: c.id, channelId: tmall.id, yearMonth: "2026-07", qty: "4.0000" },   // 两侧 < 10 → below_floor
    { skuId: d.id, channelId: tmall.id, yearMonth: "2026-07", qty: "30.0000" },  // 仅内部
    { skuId: a.id, channelId: tmall.id, yearMonth: "2026-09", qty: "10.0000" },  // 锚点月，不比
  ]);
  return { db, client, a, b, c, d, tmall };
}

/** 精简种子：单 SKU A，外部日销（日期, 支付件数）+ 内部月销量（月, 数量），无退款 */
async function seedRange(external: [string, string][], internal: [string, string][]) {
  const { db, client } = await createTestDb();
  const [actor] = await db.insert(schema.users).values({ name: "数据责任人", roles: ["pmc"] }).returning();
  const [tmall] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P90011", nameCn: "一致性范围测试" }).returning();
  const [a] = await db.insert(schema.skus).values({ code: "SC-R", name: "货品SC-R", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [crosswalk, sales] = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "cw", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_sales_observation", filename: "sales", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
  ]).returning();
  const finishedAt = new Date("2026-09-02T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "cw-r", status: "succeeded", importJobId: crosswalk.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "sales-r", status: "succeeded", importJobId: sales.id, finishedAt },
  ]);
  await db.insert(schema.stagingRows).values([
    { importJobId: crosswalk.id, rowNo: 1, status: "pending" as const, targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: "旗舰店", platformSkuId: "P-R" }, _identity: { skuId: a.id } } },
    ...external.map(([date, paid], i) => ({
      importJobId: sales.id, rowNo: i + 1, status: "pending" as const, targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: date, shopName: "旗舰店", skuId: "P-R", paidNumber: paid } },
    })),
  ]);
  await db.insert(schema.salesMonthly).values(internal.map(([yearMonth, qty]) => ({ skuId: a.id, channelId: tmall.id, yearMonth, qty })));
  return { db, client, a };
}

describe("monthsBetween", () => {
  it("[from, to) 自然月序列，跨年；from ≥ to 为空", () => {
    expect(monthsBetween("2026-06", "2026-09")).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(monthsBetween("2026-09", "2026-09")).toEqual([]);
    expect(monthsBetween("2026-10", "2026-09")).toEqual([]);
  });
});

describe("judgeConsistency 三阈值", () => {
  it("相对容差 / 绝对下限 / 量下限", () => {
    expect(judgeConsistency("100", "108", T)).toMatchObject({ status: "consistent", diffQty: "-8.0000", diffPct: 7.41 });
    expect(judgeConsistency("100", "112", T).status).toBe("exception"); // 差 12 > max(5, 112 × 10%)
    expect(judgeConsistency("12", "16", T).status).toBe("consistent"); // 差 4 ≤ 绝对下限 5（相对只允许 1.6）
    expect(judgeConsistency("12", "18", T).status).toBe("exception");
    expect(judgeConsistency("3", "9", T).status).toBe("below_floor");
    expect(judgeConsistency("0", "0", T)).toMatchObject({ status: "below_floor", diffPct: null });
    expect(judgeConsistency("0", "50", { ...T, minBaseQty: 0 })).toMatchObject({ status: "exception", diffPct: 100 });
  });
});

describe("销量口径一致性读模型", () => {
  it("只比两侧都有的完整月；单侧缺失与锚点月不进分母；缓存随绑定失效", async () => {
    const { db, client, a, b } = await seed();
    try {
      const r = await computeSalesConsistency(db, { channelCode: "tmall", thresholds: T });
      expect(r.state).toBe("ready");
      expect(r.authority).toBe("observation_only");
      expect(r.anchorDate).toBe("2026-09-02");
      expect(r.externalRange).toEqual({ from: "2026-07-01", through: "2026-09-02" });
      expect(r.months).toEqual(["2026-07"]);
      expect(r.comparedMonths).toEqual(["2026-07"]);
      expect(r.skippedMonths).toEqual(["2026-08"]); // 外部完整、内部无 8 月 → 内部缺月，跳过
      expect(r.partialMonths).toEqual(["2026-09"]); // 锚点月
      expect(r.comparedRows).toBe(3);
      expect(r.consistentRows).toBe(1);
      expect(r.exceptionRows).toBe(1);
      expect(r.belowFloorRows).toBe(1);
      expect(r.consistencyPct).toBe(50);
      // D 7 月仅内部；A 8 月仅外部；A 9 月内部落在外部不完整月
      expect(r.uncovered).toEqual({ internalOnlyRows: 1, externalOnlyRows: 1, internalOutsideRangeRows: 1 });
      expect(r.limitations.some((l) => l.includes("内部缺月") && l.includes("2026-08"))).toBe(true);
      expect(r.limitations.some((l) => l.includes("仅覆盖天猫"))).toBe(true);
      expect(r.exceptions).toHaveLength(1);
      expect(r.exceptions[0]).toMatchObject({ skuId: b.id, skuCode: "SC-B", month: "2026-07", internalQty: "150.0000", externalQty: "200.0000", diffQty: "-50.0000", diffPct: 25 });
      expect(r.exceptions.some((x) => x.skuId === a.id)).toBe(false);

      const cached = await loadSalesConsistency(db, { channelCode: "tmall", thresholds: T });
      expect(cached.consistencyPct).toBe(50);
      // 内部销量修正后绑定变化 → 重算
      await db.insert(schema.salesMonthly).values({ skuId: b.id, channelId: (await db.select().from(schema.channels))[0].id, yearMonth: "2026-06", qty: "1.0000" });
      const again = await refreshSalesConsistency(db, { channelCode: "tmall", thresholds: T });
      // 6 月早于外部观察首月：外部未覆盖，不算「仅内部」也不算不一致
      expect(again.uncovered).toEqual({ internalOnlyRows: 1, externalOnlyRows: 1, internalOutsideRangeRows: 2 });
      expect(again.consistencyPct).toBe(50);
      expect((await loadSalesConsistency(db, { channelCode: "tmall", thresholds: T })).uncovered.internalOutsideRangeRows).toBe(2);
      const [cache] = await db.select().from(schema.reportReadModelCache);
      expect(cache.key).toBe(SALES_CONSISTENCY_CACHE_KEY);
      expect(SALES_CONSISTENCY_CACHE_KEY).toBe("sales-consistency/v2");
    } finally {
      await client.close();
    }
  });

  it("内部只有 6 月、外部有 6–8 月（锚点 9 月）→ 只比 6 月；内部缺月 7/8 月跳过不记为不一致", async () => {
    const { db, client, a } = await seedRange([
      ["2026-06-01", "40"], ["2026-06-18", "60"], ["2026-07-05", "70"], ["2026-08-10", "80"], ["2026-09-01", "5"],
    ], [["2026-06", "100.0000"]]);
    try {
      const r = await computeSalesConsistency(db, { channelCode: "tmall", thresholds: T });
      expect(r.state).toBe("ready");
      expect(r.comparedMonths).toEqual(["2026-06"]);
      expect(r.skippedMonths).toEqual(["2026-07", "2026-08"]);
      expect(r.partialMonths).toEqual(["2026-09"]);
      expect(r).toMatchObject({ comparedRows: 1, consistentRows: 1, exceptionRows: 0, consistencyPct: 100 });
      expect(r.uncovered).toEqual({ internalOnlyRows: 0, externalOnlyRows: 2, internalOutsideRangeRows: 0 });
      expect(r.exceptions).toHaveLength(0);
      expect(r.exceptions.some((x) => x.skuId === a.id)).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("外部观察首日非 1 号：头月不完整不比（生产首跑 1.35% 的根因），不把半个月的外部量当例外", async () => {
    const { db, client } = await seedRange([
      ["2026-06-15", "30"], ["2026-06-20", "20"], ["2026-07-02", "1"],
    ], [["2026-06", "100.0000"]]);
    try {
      const r = await computeSalesConsistency(db, { channelCode: "tmall", thresholds: T });
      expect(r.state).toBe("insufficient");
      expect(r.comparedMonths).toEqual([]);
      expect(r.partialMonths).toEqual(["2026-06", "2026-07"]);
      expect(r.skippedMonths).toEqual([]);
      expect(r).toMatchObject({ comparedRows: 0, exceptionRows: 0, consistencyPct: null });
      expect(r.uncovered).toEqual({ internalOnlyRows: 0, externalOnlyRows: 0, internalOutsideRangeRows: 1 });
      expect(r.gate).toContain("不足一个完整自然月");
    } finally {
      await client.close();
    }
  });

  it("没有天猫批次或渠道主档缺失时保持关闭，不伪造一致率", async () => {
    const { db, client } = await createTestDb();
    try {
      const r = await computeSalesConsistency(db, { thresholds: T });
      expect(r).toMatchObject({ state: "insufficient", consistencyPct: null, comparedRows: 0 });
      expect(r.gate).toContain("缺少天猫日销量");
    } finally {
      await client.close();
    }
  });
});
