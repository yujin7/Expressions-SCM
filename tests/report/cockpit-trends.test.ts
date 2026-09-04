/**
 * 驾驶舱趋势与交叉块（BI 深化）：只装配不重算；五态块；金额对非价格角色在服务层剥离；
 * 观察序列只给方向与百分比；受限渠道账号只拿到按映射裁剪的店铺行；
 * 真实形状的读模型缓存 payload（按各读模型 TypeScript 类型）+ PGlite 事实表种子。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb } from "../helpers/db";
import {
  buildAlertPrecision,
  buildDailyFlow,
  buildExternalDemandBrief,
  buildQuadrant,
  buildSupplierConcentration,
  buildTierMigration,
  buildTodoCompletionStrict,
  buildTurnoverWindows,
  getCockpitTrends,
  loadTierMigration,
} from "@/server/modules/report/cockpit-trends";
import { buildRiskExpiryBuckets, loadRiskExpiryBuckets, RISK_EXPIRY_BUCKETS_KEY } from "@/server/modules/report/risk-expiry-buckets";
import { loadSourceRunHistory, mondayOf, weekKeys } from "@/server/modules/report/source-run-history";
import { listBelowFloor, listManualOverrides } from "@/server/modules/dq/lists";
import type { RiskRow } from "@/server/modules/report/risk";
import type { SupplierPaymentTermModel, SupplierPaymentTermRow } from "@/server/modules/report/supplier-payment-term";
import type { TodoStatsRow } from "@/server/modules/todo/stats";
import { INVENTORY_POSITION_CACHE_KEY, inventoryPositionBinding, type DailyPoint } from "@/server/modules/report/inventory-position";
import { loadPurchaseOrderMetrics, PURCHASE_ORDER_METRICS_KEY } from "@/server/modules/report/purchase-order-metrics";
import { loadChannelObservation, type ChannelPlatformRow } from "@/server/modules/report/channel-observation";
import type { RollingDemandBrief } from "@/server/modules/report/external-demand-signal";
import { extractAutoValue, AUTO_METRIC_SOURCES } from "@/server/modules/goals/service";
import type { WarehouseInventoryModel } from "@/server/modules/report/warehouse-inventory";
import { monthShanghai } from "@/server/modules/todo/stats";

const emptyWindow = (): RollingDemandBrief["current"] => ({ startDate: "2026-08-28", endDate: "2026-09-03", observedDays: 0, requiredDays: 7, paidQty: 0, refundQty: 0, netQty: 0, mappedPaidQty: 0, mappedRefundQty: 0, mappedNetQty: 0, refundRatePct: null, mappedPaidCoveragePct: null });
const emptyRollingDemandBriefForTest = (): RollingDemandBrief => ({
  state: "insufficient", gate: "", anchorDate: "2026-09-03", current: emptyWindow(), previous: emptyWindow(),
  change: { paidQtyPct: null, netQtyPct: null, refundRateDeltaPp: null, mappedPaidCoverageDeltaPp: null },
  movement: { netDemand: "unknown", refundRate: "unknown", mappedPaidCoverage: "unknown" },
});

const su = (id: number, name: string, roles: string[], channelScope: number[] | null = null): SessionUser => ({ id, name, roles, isApprover: false, channelScope });

function dailyPoint(date: string, out: string | null): DailyPoint {
  return {
    date,
    realtime: out == null ? null : { in: "0.0000", out, net: `-${out}`, inValue: { amount: null, coveragePct: null, incomplete: true, uncoveredSkus: 0 } as never, outValue: { amount: null, coveragePct: null, incomplete: true, uncoveredSkus: 0 } as never, ledgerRows: 1 },
    snapshot: null,
  };
}

describe("驾驶舱趋势块 · 纯装配函数", () => {
  it("日级出入库：实时/快照分序列，周环比取最近 7 个有账日 vs 之前 7 个，不足 14 天为 insufficient", () => {
    const days = Array.from({ length: 16 }, (_, i) => dailyPoint(`2026-09-${String(i + 1).padStart(2, "0")}`, i < 2 ? null : i < 9 ? "5.0000" : "10.0000"));
    const b = buildDailyFlow(days);
    expect(b.points).toHaveLength(16);
    expect(b.points[0]).toMatchObject({ realtimeOut: null, snapshotOut: null });
    expect(b.wow.realtime).toMatchObject({ state: "ready", currentOut: "70.0000", previousOut: "35.0000", pct: 100 });
    expect(b.wow.snapshot.state).toBe("insufficient");
    const short = buildDailyFlow(days.slice(0, 10));
    expect(short.wow.realtime.state).toBe("insufficient");
    expect(short.wow.realtime.pct).toBeNull();
  });

  it("外部需求简报：observedDays < requiredDays 必须 insufficient；只下发方向与百分比，不带件数键", () => {
    const brief = emptyRollingDemandBriefForTest();
    brief.state = "ready";
    brief.current = { ...brief.current, observedDays: 7, requiredDays: 7, refundRatePct: 3.2 };
    brief.previous = { ...brief.previous, observedDays: 7, requiredDays: 7 };
    brief.change = { paidQtyPct: 12.5, netQtyPct: 10.1, refundRateDeltaPp: -0.4, mappedPaidCoverageDeltaPp: 0 };
    brief.movement = { netDemand: "up", refundRate: "down", mappedPaidCoverage: "flat" };
    const ok = buildExternalDemandBrief(brief);
    expect(ok.sufficient).toBe(true);
    expect(ok.block.change.netQtyPct).toBe(10.1);
    expect(ok.block.authority).toBe("observation_only");
    expect(JSON.stringify(ok.block)).not.toMatch(/netQty"|paidQty"|mappedNetQty/);
    brief.previous = { ...brief.previous, observedDays: 4 };
    expect(buildExternalDemandBrief(brief).sufficient).toBe(false);
  });

  it("象限：未映射 SKU 排除不按 0 处理；断货 = 覆盖薄且外部在卖；呆滞 = 覆盖厚（含可销 ∞）且外部 30 天无动销", () => {
    const rows = [
      { skuId: 1, code: "A", brand: null, tier: "S" as const, coverDays: 3, alertDays: 10, onHand: "10.0000", priorityScore: "9" },
      { skuId: 2, code: "B", brand: "N", tier: "C" as const, coverDays: null, alertDays: 10, onHand: "500.0000", priorityScore: "1" },
      { skuId: 3, code: "C", brand: "N", tier: "A" as const, coverDays: 40, alertDays: 10, onHand: "100.0000", priorityScore: "2" },
      { skuId: 4, code: "D", brand: "N", tier: "B" as const, coverDays: 400, alertDays: 10, onHand: "100.0000", priorityScore: "2" },
      { skuId: 9, code: "UNMAPPED", brand: null, tier: "S" as const, coverDays: 1, alertDays: 10, onHand: "1.0000", priorityScore: "9" },
    ];
    const vel = { bySku: { "1": { tmallNet30: 30, activeDays90: 20, platformSkus: 1 }, "2": { tmallNet30: 0, activeDays90: 0, platformSkus: 2 }, "3": { tmallNet30: 5, activeDays90: 3, platformSkus: 1 }, "4": { tmallNet30: 0, activeDays90: 0, platformSkus: 1 } } };
    const q = buildQuadrant({ rows }, vel, 180);
    expect(q.coverage).toEqual({ alertRows: 5, mappedRows: 4, unmappedRows: 1 });
    expect(q.counts).toEqual({ stockout_risk: 1, writeoff_risk: 2, healthy: 1, watch: 0 });
    expect(q.axis.y).toBe("外部观察净件数（天猫）");
    expect(q.pddIncluded).toBe(false);
    expect(q.points.map((p) => p.code)).toEqual(["A", "B", "D", "C"]);
  });

  it("三窗口周转：快照仓不计；流水最早日晚于窗口起点或零出库时压制并给原因", () => {
    const row = (windowDays: number, turns: number | null, mode: "realtime" | "snapshot" = "realtime") => ({
      warehouseId: 1, code: "W1", name: "仓一", kind: "finished", accountingMode: mode, regionCode: "HZ", parentId: null, parentName: null, active: true,
      onHand: "100.0000", skuCount: 1, amount: null, valuationCoveragePct: null, valuationIncomplete: true, snapshotDate: null,
      outboundQty: turns == null ? "0.0000" : "50.0000", openingOnHand: "100.0000", avgOnHand: "100.0000", turns, dio: turns == null ? null : Math.round(365 / turns), turnoverNote: null,
    });
    const model = (windowDays: number, windowStart: string, turns: number | null): WarehouseInventoryModel => ({
      key: `warehouse-inventory/v1/w${windowDays}`, builtAt: "2026-09-04T00:00:00.000Z", asOf: "2026-09-04", windowDays, windowStart,
      rows: [row(windowDays, turns), { ...row(windowDays, 9, "snapshot"), warehouseId: 2, code: "W2" }], regions: [],
      summary: { warehouseCount: 2, realtimeCount: 1, snapshotCount: 1, physicalActiveCount: 2, onHand: "200.0000", amount: null, valuationCoveragePct: null, outboundQty: "50.0000", avgOnHand: "100.0000", turns, dio: turns == null ? null : Math.round(365 / turns), latestSnapshotDate: null },
      limitations: [],
    });
    const b = buildTurnoverWindows([model(365, "2025-09-04", 1.2), model(30, "2026-08-05", 6.1), model(90, "2026-06-06", null)], "2026-01-01");
    expect(b.windows).toEqual([30, 90, 365]);
    expect(b.rows.map((r) => r.code)).toEqual(["W1"]);
    expect(b.rows[0].windows.map((c) => [c.windowDays, c.suppressed, c.turns])).toEqual([[30, false, 6.1], [90, true, null], [365, true, null]]);
    expect(b.rows[0].windows[2].reason).toContain("流水最早日");
    expect(b.summary[1].reason).toContain("零出库");
  });

  it("预警命中率：真+误 < 5 的分组不下发精确率（服务层算得出也置 null）；弃权不进分母；只有分组与合计计数，没有单一总分", () => {
    const b = buildAlertPrecision({
      days: 90, verifiedTotal: 9, caliber: "c",
      groups: [
        { category: "inventory_cover", sourceRule: "cover", verified: 7, truePositive: 3, falsePositive: 2, unverifiable: 2, precisionPct: 60 },
        { category: "sales_spike", sourceRule: "spike", verified: 2, truePositive: 1, falsePositive: 0, unverifiable: 1, precisionPct: 100 },
        { category: "legacy", sourceRule: null, verified: 0, truePositive: 0, falsePositive: 0, unverifiable: 0, precisionPct: null },
      ],
    });
    expect(b.groups[0]).toMatchObject({ key: "inventory_cover|cover", label: "inventory_cover / cover", scored: 5, insufficient: false, precisionPct: 60 });
    expect(b.groups[1]).toMatchObject({ key: "sales_spike|spike", scored: 1, insufficient: true, precisionPct: null });
    expect(b.groups[2]).toMatchObject({ key: "legacy|", label: "legacy", insufficient: true });
    expect(b.totals).toEqual({ truePositive: 4, falsePositive: 2, unverifiable: 3 });
    expect(b).toMatchObject({ minSample: 5, scoredGroups: 1, verifiedTotal: 9, metricIds: ["alertPrecision"] });
    expect(Object.keys(b)).not.toEqual(expect.arrayContaining(["precisionPct", "overallPrecision"]));
  });

  it("待办完成率严口径：来源关闭（自动/人工）的取消都留在分母；按月 / 按角色 / 合计三层同口径；分母 0 → null", () => {
    const row = (month: string, groupKey: string, o: Partial<TodoStatsRow>): TodoStatsRow => ({
      groupKey, groupLabel: groupKey, month, total: 0, done: 0, onTime: 0, overdue: 0, cancelled: 0,
      cancelledBySourceClose: 0, cancelledBySourceManualClose: 0, cancelledByHuman: 0,
      suspicious: 0, completionRate: null, completionRateStrict: null, onTimeRate: null, ...o,
    });
    const rows = [
      row("2026-08", "pmc", { total: 4, done: 1, cancelled: 2, cancelledBySourceClose: 1, cancelledByHuman: 1 }),
      row("2026-08", "purchasing", { total: 2, done: 2 }),
      row("2026-09", "pmc", { total: 3, done: 3 }),
    ];
    const b = buildTodoCompletionStrict(rows, ["2026-08", "2026-09"], "c");
    // 2026-08：宽 3 ÷ (6 − 2) = 75；严 3 ÷ (6 − 1) = 60
    expect(b.byMonth[0]).toMatchObject({ key: "2026-08", total: 6, done: 3, cancelled: 2, cancelledBySourceClose: 1, cancelledByHuman: 1, completionRate: 75, completionRateStrict: 60, gapPp: 15 });
    // 红队 A7：同样一条取消，若来自"人工关闭来源告警"，严口径分母不再被减掉（3 ÷ 6 = 50）
    const viaManualSourceClose = buildTodoCompletionStrict(
      [row("2026-08", "pmc", { total: 4, done: 1, cancelled: 2, cancelledBySourceClose: 1, cancelledBySourceManualClose: 1 }), row("2026-08", "purchasing", { total: 2, done: 2 })],
      ["2026-08"], "c",
    );
    expect(viaManualSourceClose.byMonth[0]).toMatchObject({ cancelledBySourceManualClose: 1, cancelledByHuman: 0, completionRate: 75, completionRateStrict: 50 });
    expect(b.byMonth[1]).toMatchObject({ key: "2026-09", completionRate: 100, completionRateStrict: 100, gapPp: 0 });
    expect(b.byRole.map((r) => r.key)).toEqual(["pmc", "purchasing"]);
    // pmc：宽 4 ÷ 5 = 80；严 4 ÷ 6 = 66.7
    expect(b.byRole[0]).toMatchObject({ total: 7, done: 4, completionRate: 80, completionRateStrict: 66.7, gapPp: 13.3 });
    expect(b.overall).toMatchObject({ key: "all", total: 9, done: 6, completionRate: 85.7, completionRateStrict: 75, gapPp: 10.7 });
    expect(b.metricIds).toEqual(["todoCompletionRate", "todoCompletionRateStrict"]);
    const empty = buildTodoCompletionStrict([], ["2026-09"], "c");
    expect(empty.byMonth[0]).toMatchObject({ total: 0, completionRate: null, completionRateStrict: null, gapPp: null });
    expect(empty.byRole).toEqual([]);
  });

  it("目标 auto 来源：platformIdentityCoverage 走分子÷分母×100；salesConsistencyPct / costSavingYtd 路径按读模型类型核对", () => {
    const cov = AUTO_METRIC_SOURCES.find((s) => s.metricKey === "platformIdentityCoverage")!;
    expect(extractAutoValue({ coverage: { platformSkus: 200, mappedPlatformSkus: 150 } }, "2026-09", cov.paths)).toEqual({ value: "75.0000", path: "coverage.mappedPlatformSkus÷coverage.platformSkus" });
    expect(extractAutoValue({ coverage: { platformSkus: 0, mappedPlatformSkus: 0 } }, "2026-09", cov.paths)).toBeNull();
    const sc = AUTO_METRIC_SOURCES.find((s) => s.metricKey === "salesConsistencyPct")!;
    expect(extractAutoValue({ salesConsistency: { consistencyPct: 91.3 } }, "2026-Q3", sc.paths)).toEqual({ value: "91.3", path: "salesConsistency.consistencyPct" });
    expect(extractAutoValue({ salesConsistency: { consistencyPct: null } }, "2026-Q3", sc.paths)).toBeNull();
    const cs = AUTO_METRIC_SOURCES.find((s) => s.metricKey === "costSavingYtd")!;
    expect(extractAutoValue({ year: 2026, summary: { costSaving: { savingYtd: "1234.50" } } }, "2026-Q3", cs.paths)).toEqual({ value: "1234.50", path: "summary.costSaving.savingYtd" });
    expect(extractAutoValue({ year: 2025, summary: { costSaving: { savingYtd: "1234.50" } } }, "2026-Q3", cs.paths)).toBeNull();
  });
});

describe("驾驶舱趋势块 · PGlite 装配", () => {
  it("空库：五屏齐全、块状态只在 ready/insufficient（无 error）；受限渠道账号外部观察 no_access", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const t = await getCockpitTrends(su(admin.id, admin.name, ["admin"]), db);
      expect(Object.keys(t.screens)).toEqual(["s1", "s2", "s3", "s4", "channels"]);
      const blocks = [t.screens.s1.dailyFlow, t.screens.s1.freshnessTrend, t.screens.s2.poTrend, t.screens.s2.externalDemand, t.screens.s2.quadrant, t.screens.s2.alertPrecision, t.screens.s2.supplierConcentration, t.screens.s3.turnoverWindows, t.screens.s3.expiryBuckets, t.screens.s4.todoThroughput, t.screens.s4.todoCompletionStrict, t.screens.s4.alertLifecycle, t.screens.s4.goalHistory, t.screens.s4.tierMigration, t.screens.s4.dataQualityTrend, t.screens.channels.brandMatrix];
      for (const b of blocks) expect(["ready", "insufficient"], b.note).toContain(b.state);
      expect(t.screens.s2.externalDemand.state).toBe("insufficient"); // 缺批次 → 简报不足，不是 0
      expect(t.screens.s2.alertPrecision.state).toBe("insufficient"); // 无已核验告警 → 不给数，不是 0%
      expect(t.screens.s2.alertPrecision.data).toMatchObject({ verifiedTotal: 0, groups: [], minSample: 5 });
      expect(t.screens.s4.todoCompletionStrict.state).toBe("insufficient");
      expect(t.calibreVersion).toBe("cockpit-trends/v2");

      const [ops] = await db.insert(schema.users).values({ name: "天猫运营", roles: ["ops"] }).returning();
      const r = await getCockpitTrends(su(ops.id, ops.name, ["ops"], [1]), db);
      expect(r.screens.s2.externalDemand.state).toBe("no_access");
      expect(r.screens.s2.quadrant.state).toBe("no_access");
      expect(r.screens.channels.brandMatrix.data?.brandMatrix).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("种子缓存 payload：采购月趋势金额对仓库角色剥离；日级序列周环比；渠道矩阵按渠道映射裁剪店铺行", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const [wh] = await db.insert(schema.users).values({ name: "仓管", roles: ["warehouse"] }).returning();
      const [ops] = await db.insert(schema.users).values({ name: "天猫运营", roles: ["ops"] }).returning();
      const thisMonth = monthShanghai(new Date());
      const prevMonth = (() => { const [y, m] = thisMonth.split("-").map(Number); const idx = y * 12 + (m - 1) - 1; return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`; })();

      // purchase-order-metrics：先由读模型自己落缓存（绑定正确），再原位替换 byMonth（真实 PoMonthRow 形状）
      await loadPurchaseOrderMetrics({}, db);
      const byMonth = [
        { month: prevMonth, poCount: 4, lineCount: 9, orderedBaseQty: "1200.0000", netAmount: "8600.00", grossAmount: "9718.00",
          otif: { evaluable: 4, hit: 3, miss: 1, pending: 0, unevaluable: 0, rate: 0.75 } },
        { month: thisMonth, poCount: 1, lineCount: 2, orderedBaseQty: "100.0000", netAmount: "700.00", grossAmount: "791.00",
          otif: { evaluable: 0, hit: 0, miss: 0, pending: 1, unevaluable: 0, rate: null } },
      ];
      await db.execute(sql`UPDATE report_read_model_cache SET payload = jsonb_set(payload, '{byMonth}', ${JSON.stringify(byMonth)}::jsonb) WHERE key = ${PURCHASE_ORDER_METRICS_KEY}`);

      // inventory-position/v1：按导出的 binding 写入最小真实形状 payload（key + daily[]）
      const days = Array.from({ length: 16 }, (_, i) => dailyPoint(`${thisMonth}-${String(i + 1).padStart(2, "0")}`, i < 2 ? null : i < 9 ? "5.0000" : "10.0000"));
      await db.insert(schema.reportReadModelCache).values({
        key: INVENTORY_POSITION_CACHE_KEY, sourceBinding: await inventoryPositionBinding(db),
        payload: { key: INVENTORY_POSITION_CACHE_KEY, builtAt: new Date().toISOString(), daily: days, monthEnd: [], warehouses: [], ledgerFirstDay: null, latestSnapshotDate: null, limitations: [], current: null },
      });

      // jiandaoyun-channel-observation/v4：读模型自落缓存后原位替换 platforms / brandMatrix（真实 ChannelPlatformRow / BrandPlatformRow 形状）
      await loadChannelObservation(db);
      const tmall: ChannelPlatformRow = {
        platform: "天猫", state: "ready", grain: "店铺 × 天猫平台 SKU × 日", sourceAsOf: "2026-09-03", anchorDate: "2026-09-03", windowFrom: "2026-08-05",
        units: 300, amount: "9000.00", refundUnits: 12,
        byBrand: [{ brand: "NING", units: 300, amount: "9000.00" }],
        byShop: [{ shop: "店A", units: 200, amount: "6000.00" }, { shop: "店B", units: 100, amount: "3000.00" }],
        brandAttribution: { mappedSku: 240, shopMaster: 0, nameGuess: 60, unattributed: 0 }, gate: "",
      };
      const pdd: ChannelPlatformRow = { ...tmall, platform: "拼多多", state: "insufficient", units: null, amount: null, refundUnits: null, byBrand: [], byShop: [], brandAttribution: { mappedSku: 0, shopMaster: 0, nameGuess: 0, unattributed: 0 }, gate: "缺批次" };
      const vip: ChannelPlatformRow = { ...pdd, platform: "唯品会" };
      const brandMatrix = [{ brand: "NING", platforms: { "天猫": { units: 300, amount: "9000.00" }, "拼多多": { units: null, amount: null }, "唯品会": { units: null, amount: null } }, totalUnits: 300 }];
      await db.execute(sql`UPDATE report_read_model_cache SET payload = jsonb_set(jsonb_set(payload, '{platforms}', ${JSON.stringify([tmall, pdd, vip])}::jsonb), '{brandMatrix}', ${JSON.stringify(brandMatrix)}::jsonb) WHERE key = 'jiandaoyun-channel-observation/v4'`);
      const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "tmall" as never }).returning();
      await db.insert(schema.aliases).values({ aliasType: "channel" as never, scope: "JIANDAOYUN", rawValue: "店A", targetId: ch.id, createdBy: admin.id });

      const a = await getCockpitTrends(su(admin.id, admin.name, ["admin"]), db);
      expect(a.screens.s2.poTrend.state).toBe("ready");
      const aPts = a.screens.s2.poTrend.data!.points;
      expect(aPts.find((p) => p.month === prevMonth)).toMatchObject({ poCount: 4, netAmount: "8600.00", isCurrent: false });
      expect(aPts.find((p) => p.month === thisMonth)).toMatchObject({ isCurrent: true });
      // B5：逐月 OTIF 随点下发；当月可评为 0 → 不写 0%
      expect(aPts.find((p) => p.month === prevMonth)).toMatchObject({ otifRatePct: 75, otif: { evaluable: 4, hit: 3 } });
      expect(aPts.find((p) => p.month === thisMonth)).toMatchObject({ otifRatePct: null, otif: { evaluable: 0, pending: 1 } });
      expect(a.screens.s2.poTrend.data!.monthsWithOtif).toBe(1);
      expect(a.screens.s2.poTrend.data!.links.map((l) => l.metricId)).toContain("supplierOtif");
      expect(a.screens.s2.poTrend.source.source).toContain("purchase-order-metrics/v3");
      expect(a.screens.s2.poTrend.data!.moneyVisible).toBe(true);
      expect(a.screens.s1.dailyFlow.state).toBe("ready");
      expect(a.screens.s1.dailyFlow.data!.wow.realtime).toMatchObject({ state: "ready", pct: 100 });
      expect(a.screens.channels.brandMatrix.state).toBe("ready");
      expect(a.screens.channels.brandMatrix.data!.brandMatrix).toHaveLength(1);
      expect(a.screens.channels.brandMatrix.data!.platforms![0]).toMatchObject({ platform: "天猫", nameGuessSharePct: 20, amount: "9000.00" });
      expect(a.screens.channels.brandMatrix.data!.shops).toHaveLength(2);

      const w = await getCockpitTrends(su(wh.id, wh.name, ["warehouse"]), db);
      expect(w.screens.s2.poTrend.data!.moneyVisible).toBe(false);
      expect(w.screens.s2.poTrend.data!.points.every((p) => p.netAmount === null)).toBe(true);
      expect(w.screens.s2.poTrend.data!.points.find((p) => p.month === prevMonth)?.poCount).toBe(4); // 单数/件数全员可见
      expect(w.screens.channels.brandMatrix.data!.platforms![0].amount).toBeNull();
      expect(w.screens.channels.brandMatrix.data!.brandMatrix![0].platforms["天猫"]).toEqual({ units: 300, amount: null });
      expect(w.screens.channels.brandMatrix.data!.shops.every((s) => s.amount === null)).toBe(true);

      const r = await getCockpitTrends(su(ops.id, ops.name, ["ops"], [ch.id]), db);
      expect(r.screens.channels.brandMatrix.state).toBe("ready");
      expect(r.screens.channels.brandMatrix.data!.platforms).toBeNull();
      expect(r.screens.channels.brandMatrix.data!.brandMatrix).toBeNull();
      expect(r.screens.channels.brandMatrix.data!.shops.map((s) => s.shop)).toEqual(["店A"]); // 店B 未映射 → 剔除
      expect(r.screens.channels.brandMatrix.data!.unmappedShops).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("事实表种子：告警生命周期（年龄桶 / 知悉≠关闭 / 自动 vs 人工 / 复发）、待办吞吐按角色×月、目标历史只读登记值", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const [pmc] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
      const now = Date.now();
      const ago = (h: number) => new Date(now - h * 3600_000);
      await db.insert(schema.systemAlerts).values([
        { category: "inventory_cover", title: "a", status: "open", createdAt: ago(2), lastHitAt: ago(1), dedupeKey: "sku:1", sourceRule: "cover" },
        { category: "inventory_cover", title: "b", status: "open", createdAt: ago(24 * 5), lastHitAt: ago(1), dedupeKey: "sku:2", sourceRule: "cover", ackedBy: admin.id, ackedAt: ago(24 * 5 - 4) },
        { category: "sales_spike", title: "c", status: "open", createdAt: ago(24 * 40), lastHitAt: ago(1), dedupeKey: "psku:9", sourceRule: "spike" },
        { category: "inventory_cover", title: "a-old", status: "resolved", autoResolved: true, createdAt: ago(24 * 10), resolvedAt: ago(24 * 8), dedupeKey: "sku:1", sourceRule: "cover" },
        { category: "sales_spike", title: "d", status: "resolved", autoResolved: false, createdAt: ago(24 * 3), resolvedAt: ago(24 * 2), ackedBy: admin.id, ackedAt: ago(24 * 3 - 2), dedupeKey: "psku:7", sourceRule: "spike" },
      ]);
      await db.insert(schema.workItems).values([
        { title: "t1", assigneeId: pmc.id, assignerId: admin.id, createdBy: admin.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: "a:1", status: "done", completedAt: ago(1), createdAt: ago(48) },
        { title: "t2", assigneeId: pmc.id, assignerId: admin.id, createdBy: admin.id, ownerRole: "pmc", sourceKind: "alert", sourceRef: "a:2", status: "open", createdAt: ago(48) },
        { title: "manual", assigneeId: pmc.id, assignerId: admin.id, createdBy: admin.id, ownerRole: "pmc", sourceKind: "manual", status: "open", createdAt: ago(48) },
      ]);
      await db.insert(schema.departmentGoals).values([
        { deptKey: "pmc", period: "2026-06", metricKey: "turns", targetValue: "6.0000", direction: "up", actualValue: "5.4000", actualSource: "auto", createdBy: admin.id },
        { deptKey: "pmc", period: "2026-07", metricKey: "turns", targetValue: "6.0000", direction: "up", actualValue: "6.3000", actualSource: "auto", createdBy: admin.id },
        { deptKey: "pmc", period: "2026-08", metricKey: "turns", targetValue: "6.0000", direction: "up", actualValue: null, actualSource: null, createdBy: admin.id },
        { deptKey: "purchasing", period: "2026-Q3", metricKey: "onTimeRate", targetValue: "95.0000", direction: "up", actualValue: "80.0000", actualSource: "manual", createdBy: admin.id },
      ]);

      const t = await getCockpitTrends(su(admin.id, admin.name, ["admin"]), db);
      const al = t.screens.s4.alertLifecycle;
      expect(al.state).toBe("ready");
      expect(al.data!.open).toMatchObject({ total: 3, unacked: 2 });
      expect(al.data!.open.buckets.map((b) => b.count)).toEqual([1, 0, 1, 0, 1]);
      expect(al.data!.latency.ackSamples).toBe(2);
      expect(al.data!.latency.ackP50Hours).toBe(3);
      expect(al.data!.latency.resolveSamples).toBe(2);
      expect(al.data!.latency.resolveP50Hours).toBe(36); // median(48, 24)
      expect(al.data!.resolution).toEqual({ auto: 1, manual: 1 });
      expect(al.data!.recurrence).toEqual([expect.objectContaining({ sourceRule: "cover", dedupeKey: "sku:1", times: 2, open: true })]);
      expect(al.data!.byRule.map((r) => r.sourceRule)).toEqual(["cover", "spike"]);

      const todo = t.screens.s4.todoThroughput;
      expect(todo.state).toBe("ready");
      expect(todo.data!.months).toHaveLength(6);
      const pmcRow = todo.data!.rows.find((r) => r.groupKey === "pmc")!;
      expect(pmcRow).toMatchObject({ total: 2, done: 1, completionRate: 50 }); // 手工项不计入
      expect(todo.note).toContain("不排名");

      const gh = t.screens.s4.goalHistory;
      expect(gh.state).toBe("ready");
      const turns = gh.data!.series.find((s) => s.deptKey === "pmc" && s.metricKey === "turns")!;
      expect(turns.periodKind).toBe("month");
      expect(turns.points.map((p) => [p.period, p.attainment, p.attained])).toEqual([["2026-06", "90.0", false], ["2026-07", "105.0", true], ["2026-08", null, null]]);
      expect(gh.data!.series.some((s) => s.deptKey === "purchasing")).toBe(false); // 单期不成历史

      // 非本部门受限用户（deptScope）只见范围内部门的历史
      const scoped = await getCockpitTrends({ ...su(pmc.id, pmc.name, ["pmc"]), deptScope: ["pmc"] }, db);
      expect(scoped.screens.s4.goalHistory.data!.series.every((s) => s.deptKey === "pmc")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("闭环审计块：预警命中率从 alert_events(verify) 按 category × sourceRule 计数（90 天窗口、真+误 < 5 不给精确率）；待办严口径把来源自动关闭的取消留在分母", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const [pmc] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
      const now = Date.now();
      const ago = (h: number) => new Date(now - h * 3600_000);
      const resolved = (category: string, sourceRule: string, i: number, autoResolved = false) => ({
        category, title: `${sourceRule}-${i}`, status: "resolved", autoResolved, createdAt: ago(24 * 20), resolvedAt: ago(24 * 10), dedupeKey: `${category}:${i}`, sourceRule,
      });
      // 7 条 inventory_cover/cover：6 条在窗口内核验（3 真 2 误 1 弃权），第 7 条核验在 100 天前（窗口外不计）
      const cover = await db.insert(schema.systemAlerts).values(Array.from({ length: 7 }, (_, i) => resolved("inventory_cover", "cover", i))).returning({ id: schema.systemAlerts.id });
      const [spike] = await db.insert(schema.systemAlerts).values([resolved("sales_spike", "spike", 0)]).returning({ id: schema.systemAlerts.id });
      const results = ["true_positive", "true_positive", "true_positive", "false_positive", "false_positive", "unverifiable", "true_positive"];
      await db.insert(schema.alertEvents).values([
        ...cover.map((a, i) => ({ alertId: a.id, event: "verify", at: i === 6 ? ago(24 * 100) : ago(1), evidenceRef: { result: results[i] }, idempotencyKey: `${a.id}:verify` })),
        { alertId: spike.id, event: "verify", at: ago(1), evidenceRef: { result: "true_positive" }, idempotencyKey: `${spike.id}:verify` },
      ]);
      // 待办取消拆分：来源告警 autoResolved（引擎迟滞关闭）vs 人工关闭
      const [autoA] = await db.insert(schema.systemAlerts).values([resolved("inventory_cover", "cover", 100, true)]).returning({ id: schema.systemAlerts.id });
      const [manA] = await db.insert(schema.systemAlerts).values([resolved("inventory_cover", "cover", 101, false)]).returning({ id: schema.systemAlerts.id });
      const wi = (title: string, sourceRef: string, status: string) => ({
        title, assigneeId: pmc.id, assignerId: admin.id, createdBy: admin.id, ownerRole: "pmc", sourceKind: "alert", sourceRef, status, createdAt: ago(48),
        completedAt: status === "done" ? ago(1) : null,
      });
      await db.insert(schema.workItems).values([
        wi("auto-cancel", String(autoA.id), "cancelled"),
        wi("human-cancel", String(manA.id), "cancelled"),
        wi("done", "a:9", "done"),
        wi("open", "a:10", "open"),
      ]);

      const t = await getCockpitTrends(su(admin.id, admin.name, ["admin"]), db);
      const ap = t.screens.s2.alertPrecision;
      expect(ap.state).toBe("ready");
      expect(ap.data!.verifiedTotal).toBe(7);
      expect(ap.data!.totals).toEqual({ truePositive: 4, falsePositive: 2, unverifiable: 1 });
      expect(ap.data!.groups.find((g) => g.key === "inventory_cover|cover")).toMatchObject({ verified: 6, truePositive: 3, falsePositive: 2, unverifiable: 1, scored: 5, insufficient: false, precisionPct: 60 });
      expect(ap.data!.groups.find((g) => g.key === "sales_spike|spike")).toMatchObject({ verified: 1, truePositive: 1, scored: 1, insufficient: true, precisionPct: null });
      expect(ap.data!.scoredGroups).toBe(1);
      expect(ap.note).toContain("可评分组 1/2");
      expect(ap.source.tier).toBe("fact");

      const ts = t.screens.s4.todoCompletionStrict;
      expect(ts.state).toBe("ready");
      /* 红队 A7：来源被**人工**关闭而取消的待办自成一桶，且留在严口径分母——
         宽 1 ÷ (4 − 2) = 50；严 1 ÷ (4 − 0) = 25（原来它并进 cancelledByHuman，严口径能被抬到 33.3）。 */
      expect(ts.data!.overall).toMatchObject({
        total: 4, done: 1, cancelled: 2, cancelledBySourceClose: 1, cancelledBySourceManualClose: 1, cancelledByHuman: 0,
        completionRate: 50, completionRateStrict: 25, gapPp: 25,
      });
      expect(ts.data!.byRole.map((r) => r.key)).toEqual(["pmc"]);
      expect(ts.data!.months).toHaveLength(6);
      expect(ts.note).toContain("不排名");
      expect(ts.note).toContain("人工关闭来源告警");
      // 宽口径块与严口径块同源同数
      expect(t.screens.s4.todoThroughput.data!.rows.find((r) => r.groupKey === "pmc")).toMatchObject({ total: 4, cancelledBySourceClose: 1, cancelledBySourceManualClose: 1, cancelledByHuman: 0, completionRate: 50, completionRateStrict: 25 });
    } finally {
      await client.close();
    }
  });
});

describe("驾驶舱趋势块 · BI wave 2 纯装配函数", () => {
  const spendRow = (over: Partial<SupplierPaymentTermRow> & { supplierId: number; total: string | null }): SupplierPaymentTermRow => ({
    supplierId: over.supplierId,
    code: over.code ?? `S${over.supplierId}`,
    name: over.name ?? `供应商${over.supplierId}`,
    kinds: over.kinds ?? ["raw"],
    status: "active",
    pool: over.pool ?? "raw",
    cooperationSince: "2023-01-01",
    cooperationSource: over.cooperationSource ?? "system_inferred",
    cooperationYears: over.cooperationYears ?? 3,
    spend: [{ year: 2026, poNet: over.total, jsSettle: "0.00", total: over.total, rank: over.spend?.[0]?.rank ?? null, rankOf: 5 }],
    rankTrend: over.rankTrend ?? "unknown",
    candidate: false,
    candidateReason: "",
    paymentTermType: over.paymentTermType ?? null,
    creditDays: over.creditDays ?? null,
    paymentTermEffectiveFrom: null,
    paymentTermText: over.paymentTermText ?? null,
    attainment: over.attainment ?? "unknown",
  });

  const sptModel = (rows: SupplierPaymentTermRow[], totalSpend: string | null): SupplierPaymentTermModel => ({
    key: "supplier-payment-term/v1",
    authority: "ledger",
    sourceBinding: "t",
    builtAt: new Date().toISOString(),
    asOf: "2026-09-04",
    year: 2026,
    moneyVisible: true,
    params: { minYears: 2, targetMinDays: 45, targetMaxDays: 60 },
    summary: {
      suppliers: rows.length, withSpend: rows.length, candidates: 2, candidatesAttained: 1, attainmentRate: 0.5,
      creditTermSuppliers: 1, totalSpend, creditTermSpend: "300.00", creditTermSpendSharePct: "30.00", byPool: [],
    },
    rows,
    limitations: [],
  });

  it("供应商集中度：占比对非价格角色照常下发、金额剥离；OTIF 只在该供应商当年有可评 PO 时给值", () => {
    const rows = [
      spendRow({ supplierId: 1, total: "500.00", attainment: "attained", paymentTermText: "月结 60 天" }),
      spendRow({ supplierId: 2, total: "300.00" }),
      spendRow({ supplierId: 3, total: "200.00" }),
    ];
    const po = {
      bySupplier: [
        { supplierId: 1, otif: { evaluable: 4, hit: 3, miss: 1, pending: 0, unevaluable: 0, rate: 0.75 } },
        { supplierId: 2, otif: { evaluable: 0, hit: 0, miss: 0, pending: 2, unevaluable: 1, rate: null } },
      ],
      // 只读 bySupplier：其余字段与本函数无关
    } as unknown as Parameters<typeof buildSupplierConcentration>[1];

    const admin = buildSupplierConcentration(sptModel(rows, "1000.00"), po, ["admin"]);
    expect(admin.moneyVisible).toBe(true);
    expect(admin.topSharePct).toBe(100);
    expect(admin.rows.map((r) => [r.supplierId, r.spend, r.sharePct])).toEqual([[1, "500.00", 50], [2, "300.00", 30], [3, "200.00", 20]]);
    expect(admin.rows[0].otifRatePct).toBe(75);
    expect(admin.rows[1].otif).toMatchObject({ evaluable: 0 });
    expect(admin.rows[1].otifRatePct).toBeNull(); // 可评 0 → 不写 0%
    expect(admin.rows[2].otif).toBeNull(); // 当年无已批 PO → null，不是 0
    expect(admin.otifMatched).toBe(2);
    expect(admin.cooperationInferred).toBe(3);
    expect(admin.link).toBe("/report/supplier-scorecard");

    const wh = buildSupplierConcentration(sptModel(rows, "1000.00"), po, ["warehouse"]);
    expect(wh.moneyVisible).toBe(false);
    expect(wh.rows.every((r) => r.spend === null)).toBe(true);
    expect(wh.rows.map((r) => r.sharePct)).toEqual([50, 30, 20]); // 占比不是金额，仍全员可见
    expect(wh.topSharePct).toBe(100);
  });

  it("临期桶：段位按批次剩余天数统一刻度，> 90 天不入桶；90 天兜底 SKU 计数；外部动销只作注记", () => {
    const row = (over: Partial<RiskRow> & { skuId: number }): RiskRow => ({
      skuId: over.skuId, code: `SKU${over.skuId}`, name: "x", brand: over.brand ?? null,
      action: over.action ?? "促销清库", onHand: over.onHand ?? 100, daily: 1, cover: 100,
      minDaysLeft: over.minDaysLeft ?? 10, expiredQty: 0, nearExpiryDays: 90, nearQty: 0,
      expiryBuckets: over.expiryBuckets ?? { expired: 0, d30: 0, d60: 0, d90: 0 },
      nearExpiryFallback: over.nearExpiryFallback ?? false,
      palletRemark: null, remarkMonth: null, disposalOpen: false, disposalId: null,
      externalNet30: over.externalNet30 ?? null, externalLastSold: null,
    });
    const b = buildRiskExpiryBuckets([
      row({ skuId: 1, brand: "宁", expiryBuckets: { expired: 10, d30: 20, d60: 0, d90: 0 }, nearExpiryFallback: true }),
      row({ skuId: 2, brand: "宁", expiryBuckets: { expired: 0, d30: 0, d60: 5, d90: 7 } }),
      row({ skuId: 3, brand: null, action: "滞销关注", onHand: 400, externalNet30: 12 }),
      row({ skuId: 4, brand: "别", action: "滞销关注", onHand: 50, externalNet30: 0 }),
      row({ skuId: 5, brand: "别", action: "滞销关注", onHand: 60, externalNet30: null }), // 未映射：不进注记分母
      row({ skuId: 6, brand: "别", action: "优先出库" }), // 既不临期也不呆滞 → 不进块
    ], { today: "2026-09-04", slowThreshold: 180 });

    expect(b.totals.map((t) => [t.key, t.qty, t.skus])).toEqual([
      ["expired", 10, 1], ["d30", 20, 1], ["d60", 5, 1], ["d90", 7, 1],
    ]);
    expect(b.expirySkus).toBe(2);
    expect(b.fallbackSkus).toBe(1);
    expect(b.slowSkus).toBe(3);
    expect(b.slowStillSellingExternally).toBe(1);
    expect(b.slowWithExternalSignal).toBe(2); // 未映射的 SKU5 不进分母，不按 0 处理
    expect(b.brands.map((r) => r.brand)).toContain("（未设品牌）");
    expect(b.brands.find((r) => r.brand === "宁")).toMatchObject({ expirySkus: 2, slowSkus: 0, totalQty: 42 });
    expect(b.brands.find((r) => r.brand === "别")).toMatchObject({ slowSkus: 2, slowOnHand: 110 });
  });

  it("分层迁移：只在一期出现的 SKU 落「未分层」轴；覆写优先；试点阻塞 xyzNull 单列不并入非 X", () => {
    const b = buildTierMigration(
      { from: "2026-08", to: "2026-09" },
      [
        { skuId: 1, from: "S", to: "S" },
        { skuId: 2, from: "A", to: "S" },
        { skuId: 3, from: "B", to: "C" },
        { skuId: 4, from: "未分层", to: "B" },
        { skuId: 5, from: "C", to: "未分层" },
      ],
      { period: "2026-09", scanned: 120, candidates: 8, candidateSalesSharePct: 32.5, pilotMarked: 3,
        blockers: { tierC: 40, xyzNotX: 12, xyzUnclassified: 25, leadMissing: 60, detectorHit: 2 },
      } as unknown as Parameters<typeof buildTierMigration>[2],
    );
    expect(b.axes).toEqual(["S", "A", "B", "C", "未分层"]);
    expect(b.matrix).toHaveLength(25);
    expect(b.moved).toBe(4);
    expect(b.stayed).toBe(1);
    expect(b.fromTotals).toEqual({ S: 1, A: 1, B: 1, C: 1, "未分层": 1 });
    expect(b.toTotals).toEqual({ S: 2, A: 0, B: 1, C: 1, "未分层": 1 });
    expect(b.matrix.find((c) => c.from === "A" && c.to === "S")!.skus).toBe(1);
    const keys = b.blockers.map((x) => x.key);
    expect(keys).toEqual(["leadMissing", "xyzNull", "xyzNotX", "detectorHit", "tierC"]);
    expect(b.blockers.find((x) => x.key === "xyzNull")!.skus).toBe(25);
    expect(b.blockers.find((x) => x.key === "xyzNotX")!.skus).toBe(12); // 两桶分开，不相加
    expect(b.blockers.find((x) => x.key === "leadMissing")!.link).toBe("/master/supply-params");
    expect(b.links.pilot).toBe("/replenish/pilot");
    expect(b.candidates).toBe(8);
  });

  it("周键：8 周窗口以业务日所属周的周一收尾，升序且相邻 7 天", () => {
    expect(mondayOf("2026-09-04")).toBe("2026-08-31"); // 周五 → 本周一
    expect(mondayOf("2026-08-31")).toBe("2026-08-31");
    const weeks = weekKeys("2026-09-04", 8);
    expect(weeks).toHaveLength(8);
    expect(weeks.at(-1)).toBe("2026-08-31");
    expect(weeks[0]).toBe("2026-07-13");
    expect(weeks.every((w, i) => i === 0 || Date.parse(`${w}T00:00:00Z`) - Date.parse(`${weeks[i - 1]}T00:00:00Z`) === 7 * 86400000)).toBe(true);
  });
});

describe("驾驶舱趋势块 · BI wave 2 PGlite", () => {
  it("空库：新增五块齐全且只在 ready/insufficient；来源趋势不足 3 周整条不出", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const t = await getCockpitTrends(su(admin.id, admin.name, ["admin"]), db);
      expect(t.calibreVersion).toBe("cockpit-trends/v2");
      const blocks = [t.screens.s1.freshnessTrend, t.screens.s2.supplierConcentration, t.screens.s3.expiryBuckets, t.screens.s4.tierMigration, t.screens.s4.dataQualityTrend];
      for (const b of blocks) expect(["ready", "insufficient"], b.note).toContain(b.state);
      expect(t.screens.s1.freshnessTrend.state).toBe("insufficient");
      expect(t.screens.s1.freshnessTrend.data!.weeks).toHaveLength(8);
      expect(t.screens.s1.freshnessTrend.data!.series.every((s) => s.state === "insufficient")).toBe(true);
      expect(t.screens.s4.tierMigration.state).toBe("insufficient");
      expect(t.screens.s4.tierMigration.data!.fromPeriod).toBeNull();
      expect(t.screens.s3.expiryBuckets.state).toBe("insufficient");
    } finally {
      await client.close();
    }
  });

  it("临期读模型 risk-expiry-buckets：按绑定落缓存并复用；批次变化即失效重算", async () => {
    const { db, client } = await createTestDb();
    try {
      const [brand] = await db.insert(schema.brands).values({ code: "NING", nameCn: "宁" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P0001", nameCn: "临期" }).returning();
      const [wh] = await db.insert(schema.warehouses).values({ code: "W1", name: "主仓", kind: "finished", accountingMode: "realtime", active: true }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "SKU-A", name: "甲", spuId: spu.id, brandId: brand.id, baseUom: "个", skuType: "finished" }).returning();
      const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      const today = day(0);
      await db.insert(schema.batchStocks).values([
        { skuId: sku.id, warehouseId: wh.id, batchNo: "B1", qty: "10.0000", expiryDate: day(-5), stocktakeDate: today },
        { skuId: sku.id, warehouseId: wh.id, batchNo: "B2", qty: "20.0000", expiryDate: day(20), stocktakeDate: today },
        { skuId: sku.id, warehouseId: wh.id, batchNo: "B3", qty: "30.0000", expiryDate: day(200), stocktakeDate: today }, // > 90 天：不入桶
      ]);
      // 风险工作台以在库 > 0 为前提（batch_stocks 是效期载体，不是在库账）
      await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "60.0000" });

      const first = await loadRiskExpiryBuckets(db);
      expect(first.key).toBe(RISK_EXPIRY_BUCKETS_KEY);
      expect(first.totals.find((t) => t.key === "expired")!.qty).toBe(10);
      expect(first.totals.find((t) => t.key === "d30")!.qty).toBe(20);
      expect(first.totals.find((t) => t.key === "d90")!.qty).toBe(0);
      expect(first.fallbackSkus).toBe(1); // skus.near_expiry_days 未维护 → 90 天兜底

      const [cached] = await db.select().from(schema.reportReadModelCache).where(eq(schema.reportReadModelCache.key, RISK_EXPIRY_BUCKETS_KEY));
      expect(cached.sourceBinding).toBe(first.sourceBinding);
      const second = await loadRiskExpiryBuckets(db);
      expect(second.builtAt).toBe(first.builtAt); // 绑定一致 → 命中缓存不重建

      await db.insert(schema.batchStocks).values({ skuId: sku.id, warehouseId: wh.id, batchNo: "B4", qty: "7.0000", expiryDate: day(70), stocktakeDate: today });
      const third = await loadRiskExpiryBuckets(db);
      expect(third.sourceBinding).not.toBe(first.sourceBinding);
      expect(third.totals.find((t) => t.key === "d90")!.qty).toBe(7);
    } finally {
      await client.close();
    }
  });

  it("分层迁移取两期固化分层（覆写优先）；来源运行史按 ISO 周 × 来源类给滞后天数与放行率", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P0002", nameCn: "分层" }).returning();
      const skus = await db.insert(schema.skus).values([
        { code: "S1", name: "1", spuId: spu.id, baseUom: "个", skuType: "finished" },
        { code: "S2", name: "2", spuId: spu.id, baseUom: "个", skuType: "finished" },
        { code: "S3", name: "3", spuId: spu.id, baseUom: "个", skuType: "finished" },
      ]).returning();
      await db.insert(schema.skuPlanningPolicy).values([
        { skuId: skus[0].id, period: "2026-08", tier: "A", abc: "A", ownership: "joint_review" },
        { skuId: skus[0].id, period: "2026-09", tier: "S", abc: "A", ownership: "joint_review" },
        { skuId: skus[1].id, period: "2026-08", tier: "B", abc: "B", ownership: "joint_review" },
        { skuId: skus[1].id, period: "2026-09", tier: "B", abc: "B", ownership: "joint_review", overrideTier: "C", overrideBy: admin.id }, // 覆写优先
        { skuId: skus[2].id, period: "2026-09", tier: "C", abc: "C", ownership: "ops_fallback" }, // 上期缺席 → 未分层
      ]);

      const mig = await loadTierMigration(db);
      expect(mig.periods).toEqual({ from: "2026-08", to: "2026-09" });
      const byId = new Map(mig.tiers.map((t) => [t.skuId, t]));
      expect(byId.get(skus[0].id)).toMatchObject({ from: "A", to: "S" });
      expect(byId.get(skus[1].id)).toMatchObject({ from: "B", to: "C" }); // override_tier 生效
      expect(byId.get(skus[2].id)).toMatchObject({ from: "未分层", to: "C" });

      // 运行史：三周各一个 rpa_warehouse 批次（模板 inventory），滞后天数 = 收到日 − source_as_of
      const today = new Date();
      const weeks = weekKeys(today.toISOString().slice(0, 10), 8);
      for (const [i, w] of [weeks[5], weeks[6], weeks[7]].entries()) {
        const receivedAt = new Date(`${w}T04:00:00Z`); // 周一，Asia/Shanghai 当日
        const asOf = new Date(Date.parse(`${w}T00:00:00Z`) - (i + 1) * 86400000).toISOString().slice(0, 10);
        await db.insert(schema.importJobs).values({
          template: "inventory", filename: `f${i}.xlsx`, sourceAsOf: asOf, status: "done",
          okRows: 90 + i, failRows: 10 - i, createdBy: admin.id, createdAt: receivedAt,
        });
      }
      const history = await loadSourceRunHistory(db, { today: today.toISOString().slice(0, 10) });
      expect(history.weeks).toEqual(weeks);
      const rpa = history.series.find((s) => s.sourceClass === "rpa_warehouse")!;
      expect(rpa.state).toBe("ready");
      expect(rpa.weeksWithActivity).toBe(3);
      expect(rpa.points.at(-1)!.maxAgeDays).toBe(3);
      expect(rpa.points.at(-1)!.passRatePct).toBe(92); // 92 / (92 + 8)
      expect(rpa.points[0].maxAgeDays).toBeNull(); // 无批次的周留空，不按 0
      expect(rpa.points[0].passRatePct).toBeNull();
      // 其余来源类无批次 → 不足 3 周，整条不出
      expect(history.series.filter((s) => s.state === "ready")).toHaveLength(1);

      const t = await getCockpitTrends(su(admin.id, admin.name, ["admin"]), db);
      expect(t.screens.s4.tierMigration.state).toBe("ready");
      expect(t.screens.s4.tierMigration.data!.moved).toBe(3);
      expect(t.screens.s1.freshnessTrend.state).toBe("ready");
      expect(t.screens.s4.dataQualityTrend.state).toBe("ready");
      expect(t.screens.s4.dataQualityTrend.data!.readySeries).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("数据质量清单（C10）：手工改写按替代链取值、金额按角色剥离；低于量下限走一致性同一判定", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      const [head] = await db.insert(schema.salesAmountMonthly).values({
        yearMonth: "2026-07", scopeKind: "company", amount: "1000.00", source: "manual", createdBy: admin.id,
      }).returning();
      await db.insert(schema.salesAmountMonthly).values({
        yearMonth: "2026-07", scopeKind: "company", amount: "1200.00", source: "manual",
        supersedesId: head.id, note: "对账后修正", createdBy: admin.id,
      });

      const forAdmin = await listManualOverrides(db, {}, ["admin"]);
      expect(forAdmin.total).toBe(1);
      expect(forAdmin.moneyVisible).toBe(true);
      expect(forAdmin.rows[0]).toMatchObject({ yearMonth: "2026-07", scopeLabel: "全公司", amount: "1200.00", previousAmount: "1000.00", createdByName: "管理员" });

      const forWarehouse = await listManualOverrides(db, {}, ["warehouse"]);
      expect(forWarehouse.rows[0].amount).toBeNull();
      expect(forWarehouse.rows[0].previousAmount).toBeNull();
      expect(forWarehouse.total).toBe(1); // 计数与口径仍可见

      expect((await listManualOverrides(db, { yearMonth: "2026-06" }, ["admin"])).total).toBe(0);

      // 缺天猫批次时一致性关闭：清单必须给 gate 而不是空表假装「没有问题」
      const bf = await listBelowFloor(db, {});
      expect(bf.state).toBe("insufficient");
      expect(bf.rows).toEqual([]);
      expect(bf.gate).toBeTruthy();
      expect(bf.caliber).toContain("不进一致率分母");
    } finally {
      await client.close();
    }
  });
});
