/**
 * 驾驶舱趋势与交叉块（BI 深化）：只装配不重算；五态块；金额对非价格角色在服务层剥离；
 * 观察序列只给方向与百分比；受限渠道账号只拿到按映射裁剪的店铺行；
 * 真实形状的读模型缓存 payload（按各读模型 TypeScript 类型）+ PGlite 事实表种子。
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb } from "../helpers/db";
import {
  buildDailyFlow,
  buildExternalDemandBrief,
  buildQuadrant,
  buildTurnoverWindows,
  getCockpitTrends,
} from "@/server/modules/report/cockpit-trends";
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
      const blocks = [t.screens.s1.dailyFlow, t.screens.s2.poTrend, t.screens.s2.externalDemand, t.screens.s2.quadrant, t.screens.s3.turnoverWindows, t.screens.s4.todoThroughput, t.screens.s4.alertLifecycle, t.screens.s4.goalHistory, t.screens.channels.brandMatrix];
      for (const b of blocks) expect(["ready", "insufficient"], b.note).toContain(b.state);
      expect(t.screens.s2.externalDemand.state).toBe("insufficient"); // 缺批次 → 简报不足，不是 0
      expect(t.calibreVersion).toBe("cockpit-trends/v1");

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

      // purchase-order-metrics/v1：先由读模型自己落缓存（绑定正确），再原位替换 byMonth（真实 PoMonthRow 形状）
      await loadPurchaseOrderMetrics({}, db);
      const byMonth = [
        { month: prevMonth, poCount: 4, lineCount: 9, orderedBaseQty: "1200.0000", netAmount: "8600.00", grossAmount: "9718.00" },
        { month: thisMonth, poCount: 1, lineCount: 2, orderedBaseQty: "100.0000", netAmount: "700.00", grossAmount: "791.00" },
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
});
