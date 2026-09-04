import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { and, inArray, type SQL } from "drizzle-orm";
import { PRICE_VISIBLE_ROLES, ROLES } from "@/server/core/constants";
import { resolveChannelScope, resolveDeptScope } from "@/server/core/data-scope";
import { dAdd, dCmp, dDiv, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { getNumParam } from "@/server/core/params";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { alertPrecision, ALERT_OUTCOME_VERSION, type AlertPrecisionGroup, type AlertPrecisionSummary } from "@/jobs/alert-outcome";
import { momPct } from "@/server/rules/period-compare";
import type { Tier } from "@/server/rules/abc";
import { ratePctNumOf, type Block, type CockpitSource } from "@/server/modules/report/cockpit";
import { CHANNEL_OBSERVATION_CACHE_KEY, loadChannelObservation, filterShopRowsByChannelScope, loadShopChannelMap, type BrandPlatformRow, type ChannelPlatform } from "@/server/modules/report/channel-observation";
import { EXTERNAL_DEMAND_SIGNAL_CACHE_KEY, loadJiandaoyunExternalDemandSignal, type RollingDemandBrief, type RollingDemandWindow } from "@/server/modules/report/external-demand-signal";
import { EXTERNAL_VELOCITY_CACHE_KEY, loadExternalVelocitySafe } from "@/server/modules/report/external-velocity";
import { INVENTORY_ALERTS_CACHE_KEY, loadInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { INVENTORY_POSITION_CACHE_KEY, loadInventoryPosition, todayShanghai, type DailyPoint } from "@/server/modules/report/inventory-position";
import { loadPurchaseOrderMetrics, PURCHASE_ORDER_METRICS_KEY, stripPurchaseOrderMoney, type OtifStats, type PoMonthRow, type PurchaseOrderMetrics } from "@/server/modules/report/purchase-order-metrics";
import { loadReplenishPilot, PILOT_CACHE_KEY, type PilotReadModel } from "@/server/modules/report/replenish-pilot";
import { loadRiskExpiryBuckets, RISK_EXPIRY_BUCKETS_KEY, type ExpiryBrandRow, type RiskExpiryBucketsModel } from "@/server/modules/report/risk-expiry-buckets";
import { loadSourceRunHistory, type SourceClassSeries, type SourceRunHistory } from "@/server/modules/report/source-run-history";
import {
  loadSupplierPaymentTerm, SUPPLIER_PAYMENT_TERM_KEY, SUPPLIER_POOL_LABELS,
  type AttainmentStatus, type RankTrend, type SupplierPaymentTermModel, type SupplierPaymentTermRow, type SupplierPool,
} from "@/server/modules/report/supplier-payment-term";
import { loadWarehouseInventory, WAREHOUSE_INVENTORY_CACHE_KEY, WAREHOUSE_WINDOWS, type WarehouseInventoryModel } from "@/server/modules/report/warehouse-inventory";
import { getTodoStats, monthShanghai, type TodoStatsRow } from "@/server/modules/todo/stats";
import { computeAttainment, isAttained, type GoalDirection } from "@/server/modules/goals/service";
import { METRICS } from "@/components/metrics";

/**
 * 驾驶舱「趋势与交叉」补充装配（BI 深化，独立于 cockpit.ts 的四屏主装配）。
 *
 * 只装配、不重算口径：每块都取自已有的唯一权威读模型 / 服务，块状态沿用 cockpit.ts 的五态；
 * 金额在本层按 PRICE_VISIBLE_ROLES 剥离（路由出口再经 maskSensitive 兜底）；
 * 观察类序列（简道云）只给方向与百分比，绝不下发可被误当作数量的件数；
 * 受限渠道账号（D62）不下发跨店铺聚合的外部观察，只给按渠道映射裁剪后的店铺行。
 *
 * 块清单（对应 BI 审计编号）：
 *  屏1 dailyFlow（#1）/ freshnessTrend（C6）；
 *  屏2 poTrend（#2、B5 逐月 OTIF）/ externalDemand（#3）/ quadrant（#4）/ alertPrecision（闭环审计 #3）/ supplierConcentration（C2）；
 *  屏3 turnoverWindows（#7）/ expiryBuckets（C3）；
 *  屏4 todoThroughput（#12）/ todoCompletionStrict（闭环审计 #9）/ alertLifecycle（#6）/ goalHistory（#8 历史）/ tierMigration（C5）/ dataQualityTrend（B8）；
 *  渠道观察 brandMatrix（#9）。
 */

export const COCKPIT_TRENDS_CALIBRE = "cockpit-trends/v2";

export type TrendScreen = "s1" | "s2" | "s3" | "s4" | "channels";

/* ───────────────────────── 屏1 · 日级出入库 ───────────────────────── */

export interface DailyFlowPoint {
  date: string;
  /** 实时仓（流水口径；null = 该日无账期覆盖） */
  realtimeIn: string | null;
  realtimeOut: string | null;
  /** 快照仓差分（落在后一快照日；null = 无快照可差分）——与实时序列并列，绝不相加 */
  snapshotIn: string | null;
  snapshotOut: string | null;
  snapshotSpanDays: number | null;
}

export interface WowDelta {
  state: "ready" | "insufficient";
  /** 最近 7 个有账日 vs 之前 7 个有账日的出库合计（decimal 字符串） */
  currentOut: string | null;
  previousOut: string | null;
  currentDays: number;
  previousDays: number;
  /** (current − previous) ÷ previous × 100；上期为 0 或天数不足 → null */
  pct: number | null;
  note: string;
}

export interface DailyFlowBlock {
  points: DailyFlowPoint[];
  windowFrom: string | null;
  windowTo: string | null;
  wow: { realtime: WowDelta; snapshot: WowDelta };
  metricIds: readonly ["dailyInOut"];
}

function wowOf(days: { date: string; out: string | null }[], label: string): WowDelta {
  const withData = days.filter((d) => d.out != null);
  const current = withData.slice(-7);
  const previous = withData.slice(-14, -7);
  if (current.length < 7 || previous.length < 7) {
    return {
      state: "insufficient", currentOut: null, previousOut: null, currentDays: current.length, previousDays: previous.length, pct: null,
      note: `${label}当月至今有账 ${withData.length} 天，不足 14 天不做周环比（日级序列只覆盖当月）`,
    };
  }
  const sum = (rows: { out: string | null }[]) => rows.reduce((acc, r) => dAdd(acc, r.out ?? "0", 4), "0.0000");
  const currentOut = sum(current);
  const previousOut = sum(previous);
  return {
    state: "ready", currentOut, previousOut, currentDays: 7, previousDays: 7,
    pct: momPct(currentOut, previousOut),
    note: `${label}最近 7 个有账日出库 vs 之前 7 个有账日（${previous[0]?.date} → ${current[current.length - 1]?.date}）`,
  };
}

export function buildDailyFlow(daily: DailyPoint[]): DailyFlowBlock {
  const points: DailyFlowPoint[] = daily.map((d) => ({
    date: d.date,
    realtimeIn: d.realtime?.in ?? null,
    realtimeOut: d.realtime?.out ?? null,
    snapshotIn: d.snapshot?.in ?? null,
    snapshotOut: d.snapshot?.out ?? null,
    snapshotSpanDays: d.snapshot?.maxSpanDays ?? null,
  }));
  return {
    points,
    windowFrom: points[0]?.date ?? null,
    windowTo: points[points.length - 1]?.date ?? null,
    wow: {
      realtime: wowOf(points.map((p) => ({ date: p.date, out: p.realtimeOut })), "实时仓"),
      snapshot: wowOf(points.map((p) => ({ date: p.date, out: p.snapshotOut })), "快照仓"),
    },
    metricIds: ["dailyInOut"],
  };
}

/* ───────────────────────── 屏2 · 采购订单月趋势 ───────────────────────── */

export interface PoTrendPoint {
  month: string;
  poCount: number;
  lineCount: number;
  orderedBaseQty: string;
  /** 未税金额（非价格角色 null） */
  netAmount: string | null;
  /** 逐月 OTIF（purchase-order-metrics 的 byMonth.otif，按下单月归期；键见 PURCHASE_ORDER_METRICS_KEY） */
  otif: OtifStats;
  /** 逐月 OTIF %（1dp）；可评 0 → null，绝不写成 0% */
  otifRatePct: number | null;
  /** 当月（进行中，结构性偏低）——前端置灰 */
  isCurrent: boolean;
  /** 来自历史年份即时计算（非缓存） */
  fromHistoryYear: boolean;
}

/** C10：每个采购 KPI 数字各自的下钻目标（没有死号码） */
export interface MetricLink {
  metricId: string;
  label: string;
  href: string;
}

export interface PoTrendBlock {
  points: PoTrendPoint[];
  moneyVisible: boolean;
  /** 年度累计 OTIF 保留作对照（逐月读数在 points[].otif，B5 起为主口径） */
  otifYtd: OtifStats & { year: number };
  cycle: { p50: number | null; p90: number | null; samples: number; insufficient: boolean };
  /** 逐月 OTIF 有可评样本的月份数（0 → 图上不画 OTIF 线） */
  monthsWithOtif: number;
  links: MetricLink[];
  metricIds: readonly ["poOrderedQty", "supplierOtif", "poOrderToDeliveryDays"];
}

const emptyOtifStats = (): OtifStats => ({ evaluable: 0, hit: 0, miss: 0, pending: 0, unevaluable: 0, rate: null });

export function buildPoTrend(current: PurchaseOrderMetrics, previousYear: PurchaseOrderMetrics | null, roles: string[]): PoTrendBlock {
  const cur = stripPurchaseOrderMoney(current, roles);
  const prev = previousYear ? stripPurchaseOrderMoney(previousYear, roles) : null;
  // byMonth.otif 是 v2 新增：旧缓存 payload 里可能缺席，缺席按「无可评样本」处理而不是 0%
  const point = (m: PoMonthRow, isCurrent: boolean, fromHistoryYear: boolean): PoTrendPoint => {
    const otif = m.otif ?? emptyOtifStats();
    return {
      month: m.month, poCount: m.poCount, lineCount: m.lineCount, orderedBaseQty: m.orderedBaseQty, netAmount: m.netAmount,
      otif, otifRatePct: ratePctNumOf(otif.rate), isCurrent, fromHistoryYear,
    };
  };
  const rows: PoTrendPoint[] = [
    ...(prev?.byMonth ?? []).map((m) => point(m, false, true)),
    ...cur.byMonth.map((m) => point(m, m.month === cur.month, false)),
  ].sort((a, b) => a.month.localeCompare(b.month));
  const points = rows.slice(-12);
  return {
    points,
    moneyVisible: cur.moneyVisible,
    otifYtd: { ...cur.summary.otif, year: cur.year },
    cycle: { p50: cur.summary.cycle.firstP50, p90: cur.summary.cycle.firstP90, samples: cur.summary.cycle.n, insufficient: cur.summary.cycle.insufficient },
    monthsWithOtif: points.filter((p) => p.otif.evaluable > 0).length,
    links: [
      { metricId: "poOrderedQty", label: "按月看已下单数量", href: "/report/purchase-orders?dim=month" },
      { metricId: "poOrderedAmount", label: "按品牌看已下单金额", href: "/report/purchase-orders?dim=brand" },
      { metricId: "supplierOtif", label: "按供应商看 OTIF", href: "/report/purchase-orders?dim=supplier" },
      { metricId: "poOrderToDeliveryDays", label: "按供应商看订单至交付", href: "/report/purchase-orders?dim=supplier" },
      { metricId: "costSavingYtd", label: "按供应商看降本", href: "/report/purchase-orders?dim=supplier" },
    ],
    metricIds: ["poOrderedQty", "supplierOtif", "poOrderToDeliveryDays"],
  };
}

/* ───────────────────────── 屏2 · 外部需求 7 日环比简报 ───────────────────────── */

export interface DemandWindowDto {
  startDate: string | null;
  endDate: string | null;
  observedDays: number;
  requiredDays: number;
  refundRatePct: number | null;
  mappedPaidCoveragePct: number | null;
}

export interface ExternalDemandBriefBlock {
  authority: "observation_only";
  platform: "天猫";
  anchorDate: string | null;
  gate: string;
  current: DemandWindowDto;
  previous: DemandWindowDto;
  /** 只下发方向与百分比，不下发件数（观察数据只预警不定量，D55） */
  change: RollingDemandBrief["change"];
  movement: RollingDemandBrief["movement"];
  metricIds: readonly ["externalNetDemand", "refundRate"];
}

const windowDto = (w: RollingDemandWindow): DemandWindowDto => ({
  startDate: w.startDate, endDate: w.endDate, observedDays: w.observedDays, requiredDays: w.requiredDays,
  refundRatePct: w.refundRatePct, mappedPaidCoveragePct: w.mappedPaidCoveragePct,
});

export function buildExternalDemandBrief(brief: RollingDemandBrief): { block: ExternalDemandBriefBlock; sufficient: boolean } {
  const sufficient = brief.state === "ready"
    && brief.current.observedDays >= brief.current.requiredDays
    && brief.previous.observedDays >= brief.previous.requiredDays;
  return {
    sufficient,
    block: {
      authority: "observation_only", platform: "天猫", anchorDate: brief.anchorDate, gate: brief.gate,
      current: windowDto(brief.current), previous: windowDto(brief.previous),
      change: brief.change, movement: brief.movement,
      metricIds: ["externalNetDemand", "refundRate"],
    },
  };
}

/* ───────────────────────── 屏2 · 可销天数 × 外部销速象限 ───────────────────────── */

export type Quadrant = "stockout_risk" | "writeoff_risk" | "healthy" | "watch";

export interface QuadrantPoint {
  skuId: number;
  code: string;
  brand: string | null;
  tier: Tier | null;
  /** 在库可销天数（按主日销；null = 无动销 → 视为无限） */
  coverDays: number | null;
  alertDays: number;
  onHand: string;
  /** 外部观察净件数（天猫，近 30 天）——观察口径，只用于定位象限 */
  tmallNet30: number;
  activeDays90: number;
  quadrant: Quadrant;
}

export interface QuadrantBlock {
  axis: { x: string; y: string };
  thresholds: { slowDays: number };
  counts: Record<Quadrant, number>;
  points: QuadrantPoint[];
  coverage: { alertRows: number; mappedRows: number; unmappedRows: number };
  pddIncluded: false;
  metricIds: readonly ["daysCover", "externalNetDemand"];
}

export function buildQuadrant(
  alerts: { rows: { skuId: number; code: string; brand: string | null; tier: Tier | null; coverDays: number | null; alertDays: number; onHand: string; priorityScore: string }[] },
  velocity: { bySku: Record<string, { tmallNet30: number; activeDays90: number; platformSkus: number }> },
  slowDays: number,
): QuadrantBlock {
  const counts: Record<Quadrant, number> = { stockout_risk: 0, writeoff_risk: 0, healthy: 0, watch: 0 };
  const points: QuadrantPoint[] = [];
  let unmapped = 0;
  for (const r of alerts.rows) {
    const v = velocity.bySku[String(r.skuId)];
    if (!v || v.platformSkus <= 0) { unmapped++; continue; } // 未映射 SKU 排除，不按 0 处理
    const hot = v.tmallNet30 > 0;
    const thin = r.coverDays != null && r.coverDays <= r.alertDays;
    const long = r.coverDays == null ? dCmp(r.onHand, 0) > 0 : r.coverDays >= slowDays;
    const quadrant: Quadrant = thin && hot ? "stockout_risk" : long && !hot ? "writeoff_risk" : hot ? "healthy" : "watch";
    counts[quadrant]++;
    points.push({ skuId: r.skuId, code: r.code, brand: r.brand, tier: r.tier, coverDays: r.coverDays, alertDays: r.alertDays, onHand: r.onHand, tmallNet30: v.tmallNet30, activeDays90: v.activeDays90, quadrant });
  }
  const order: Record<Quadrant, number> = { stockout_risk: 0, writeoff_risk: 1, healthy: 2, watch: 3 };
  points.sort((a, b) => order[a.quadrant] - order[b.quadrant] || b.tmallNet30 - a.tmallNet30);
  return {
    axis: { x: "在库可销天数", y: "外部观察净件数（天猫）" },
    thresholds: { slowDays },
    counts,
    points: points.slice(0, 200),
    coverage: { alertRows: alerts.rows.length, mappedRows: points.length, unmappedRows: unmapped },
    pddIncluded: false,
    metricIds: ["daysCover", "externalNetDemand"],
  };
}

/* ───────────────────────── 屏3 · 三窗口周转 ───────────────────────── */

export interface TurnoverWindowCell {
  windowDays: number;
  windowStart: string;
  outboundQty: string | null;
  turns: number | null;
  dio: number | null;
  /** 窗口数据不足时压制（不显示离谱数字） */
  suppressed: boolean;
  reason: string | null;
}

export interface TurnoverWindowRow {
  warehouseId: number;
  code: string;
  name: string;
  regionCode: string;
  onHand: string;
  windows: TurnoverWindowCell[];
}

export interface TurnoverWindowsBlock {
  windows: number[];
  summary: TurnoverWindowCell[];
  rows: TurnoverWindowRow[];
  ledgerFirstDay: string | null;
  metricIds: readonly ["warehouseTurns", "warehouseDio"];
}

function cellOf(windowDays: number, windowStart: string, outboundQty: string | null, turns: number | null, dio: number | null, ledgerFirstDay: string | null): TurnoverWindowCell {
  if (turns == null) return { windowDays, windowStart, outboundQty, turns: null, dio: null, suppressed: true, reason: "窗口内零出库或不可计算" };
  if (ledgerFirstDay != null && ledgerFirstDay > windowStart) {
    return { windowDays, windowStart, outboundQty, turns: null, dio: null, suppressed: true, reason: `流水最早日 ${ledgerFirstDay} 晚于窗口起点，窗口覆盖不完整` };
  }
  return { windowDays, windowStart, outboundQty, turns, dio, suppressed: false, reason: null };
}

export function buildTurnoverWindows(models: WarehouseInventoryModel[], ledgerFirstDay: string | null): TurnoverWindowsBlock {
  const sorted = [...models].sort((a, b) => a.windowDays - b.windowDays);
  const byWh = new Map<number, TurnoverWindowRow>();
  for (const m of sorted) {
    for (const r of m.rows) {
      if (r.accountingMode !== "realtime" || !r.active) continue; // 快照仓无流水不计算
      const row = byWh.get(r.warehouseId) ?? { warehouseId: r.warehouseId, code: r.code, name: r.name, regionCode: r.regionCode, onHand: r.onHand, windows: [] };
      row.windows.push(cellOf(m.windowDays, m.windowStart, r.outboundQty, r.turns, r.dio, ledgerFirstDay));
      byWh.set(r.warehouseId, row);
    }
  }
  return {
    windows: sorted.map((m) => m.windowDays),
    summary: sorted.map((m) => cellOf(m.windowDays, m.windowStart, m.summary.outboundQty, m.summary.turns, m.summary.dio, ledgerFirstDay)),
    rows: [...byWh.values()].sort((a, b) => a.regionCode.localeCompare(b.regionCode) || a.code.localeCompare(b.code)),
    ledgerFirstDay,
    metricIds: ["warehouseTurns", "warehouseDio"],
  };
}

/* ───────────────────────── 屏4 · 待办吞吐 ───────────────────────── */

export interface TodoThroughputBlock {
  months: string[];
  roles: string[];
  rows: TodoStatsRow[];
  caliber: string;
  metricIds: readonly ["todoCompletionRate"];
}

/* ───────────────────────── 屏4 · 告警生命周期 ───────────────────────── */

export interface AlertAgeBucket { key: string; label: string; count: number }

export interface AlertLifecycleBlock {
  total: number;
  open: { total: number; unacked: number; buckets: AlertAgeBucket[] };
  /** 中位时长（小时，1 位小数）；样本 0 → null。知悉与关闭分开：ack 不改 status */
  latency: { windowDays: number; ackP50Hours: number | null; ackSamples: number; resolveP50Hours: number | null; resolveSamples: number };
  resolution: { auto: number; manual: number };
  byRule: { sourceRule: string; total: number; open: number; autoResolved: number }[];
  recurrence: { sourceRule: string; dedupeKey: string; times: number; lastHitAt: string | null; open: boolean }[];
  metricIds: readonly ["alertTimeToAck", "alertTimeToResolve", "alertRecurrence"];
}

const AGE_BUCKETS: { key: string; label: string; from: number | null; to: number | null }[] = [
  { key: "d1", label: "≤1 天", from: null, to: 1 },
  { key: "d3", label: "1–3 天", from: 1, to: 3 },
  { key: "d7", label: "3–7 天", from: 3, to: 7 },
  { key: "d30", label: "7–30 天", from: 7, to: 30 },
  { key: "d30p", label: ">30 天", from: 30, to: null },
];
const LATENCY_WINDOW_DAYS = 90;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
const n0 = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const h1 = (v: unknown): number | null => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; };

export async function loadAlertLifecycle(db: AnyDb): Promise<AlertLifecycleBlock> {
  const bucketCols = AGE_BUCKETS.map((b) => sql.raw(
    `count(*) filter (where status = 'open'${b.from == null ? "" : ` and created_at <= now() - interval '${b.from} days'`}${b.to == null ? "" : ` and created_at > now() - interval '${b.to} days'`})::int AS ${b.key}`,
  ));
  const [agg] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) filter (where status = 'open')::int AS open_total,
           count(*) filter (where status = 'open' and acked_at is null)::int AS open_unacked,
           ${sql.join(bucketCols, sql`, `)},
           count(*) filter (where acked_at is not null and created_at >= now() - interval '${sql.raw(String(LATENCY_WINDOW_DAYS))} days')::int AS ack_samples,
           percentile_cont(0.5) within group (order by extract(epoch from (acked_at - created_at)) / 3600.0)
             filter (where acked_at is not null and created_at >= now() - interval '${sql.raw(String(LATENCY_WINDOW_DAYS))} days') AS ack_p50_h,
           count(*) filter (where status = 'resolved' and resolved_at is not null and created_at >= now() - interval '${sql.raw(String(LATENCY_WINDOW_DAYS))} days')::int AS resolve_samples,
           percentile_cont(0.5) within group (order by extract(epoch from (resolved_at - created_at)) / 3600.0)
             filter (where status = 'resolved' and resolved_at is not null and created_at >= now() - interval '${sql.raw(String(LATENCY_WINDOW_DAYS))} days') AS resolve_p50_h,
           count(*) filter (where status = 'resolved' and auto_resolved)::int AS auto_resolved,
           count(*) filter (where status = 'resolved' and not auto_resolved)::int AS manual_resolved
    FROM system_alerts
  `));
  const byRule = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT coalesce(source_rule, category) AS source_rule,
           count(*)::int AS total,
           count(*) filter (where status = 'open')::int AS open,
           count(*) filter (where status = 'resolved' and auto_resolved)::int AS auto_resolved
    FROM system_alerts GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20
  `));
  const recurrence = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT coalesce(source_rule, category) AS source_rule, dedupe_key, count(*)::int AS times,
           max(coalesce(last_hit_at, created_at))::text AS last_hit_at,
           bool_or(status = 'open') AS is_open
    FROM system_alerts WHERE dedupe_key IS NOT NULL
    GROUP BY 1, 2 HAVING count(*) >= 2 ORDER BY 3 DESC, 4 DESC LIMIT 10
  `));
  return {
    total: n0(agg?.total),
    open: { total: n0(agg?.open_total), unacked: n0(agg?.open_unacked), buckets: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: n0(agg?.[b.key]) })) },
    latency: { windowDays: LATENCY_WINDOW_DAYS, ackP50Hours: h1(agg?.ack_p50_h), ackSamples: n0(agg?.ack_samples), resolveP50Hours: h1(agg?.resolve_p50_h), resolveSamples: n0(agg?.resolve_samples) },
    resolution: { auto: n0(agg?.auto_resolved), manual: n0(agg?.manual_resolved) },
    byRule: byRule.map((r) => ({ sourceRule: String(r.source_rule ?? ""), total: n0(r.total), open: n0(r.open), autoResolved: n0(r.auto_resolved) })),
    recurrence: recurrence.map((r) => ({ sourceRule: String(r.source_rule ?? ""), dedupeKey: String(r.dedupe_key ?? ""), times: n0(r.times), lastHitAt: r.last_hit_at == null ? null : String(r.last_hit_at), open: Boolean(r.is_open) })),
    metricIds: ["alertTimeToAck", "alertTimeToResolve", "alertRecurrence"],
  };
}

/* ───────────────────────── 屏4 · 目标达成历史 ───────────────────────── */

export interface GoalHistoryPoint {
  period: string;
  targetValue: string;
  actualValue: string | null;
  actualSource: "auto" | "manual" | null;
  attainment: string | null;
  attained: boolean | null;
}

export interface GoalHistorySeries {
  deptKey: string;
  metricKey: string;
  metricLabel: string;
  unit: string | null;
  direction: GoalDirection;
  periodKind: "month" | "quarter";
  points: GoalHistoryPoint[];
}

export interface GoalHistoryBlock {
  periodsPerSeries: 6;
  series: GoalHistorySeries[];
  metricIds: readonly ["goalAttainment"];
}

export async function loadGoalHistory(db: AnyDb, user: SessionUser): Promise<GoalHistoryBlock> {
  const scope = resolveDeptScope(user, null);
  const clauses: SQL[] = [];
  if (scope.deptKeys) clauses.push(inArray(schema.departmentGoals.deptKey, scope.deptKeys));
  const q = db.select().from(schema.departmentGoals);
  const raw: (typeof schema.departmentGoals.$inferSelect)[] = await (clauses.length ? q.where(and(...clauses)) : q);
  const groups = new Map<string, GoalHistorySeries>();
  for (const r of raw) {
    const periodKind: "month" | "quarter" = r.period.includes("Q") ? "quarter" : "month";
    const key = `${r.deptKey}|${r.metricKey}|${periodKind}`;
    const direction = r.direction as GoalDirection;
    const s = groups.get(key) ?? {
      deptKey: r.deptKey, metricKey: r.metricKey, metricLabel: METRICS[r.metricKey]?.label ?? r.metricKey, unit: METRICS[r.metricKey]?.unit ?? null,
      direction, periodKind, points: [],
    };
    s.points.push({
      period: r.period, targetValue: r.targetValue, actualValue: r.actualValue, actualSource: (r.actualSource as "auto" | "manual" | null) ?? null,
      attainment: computeAttainment(r.targetValue, r.actualValue, direction), attained: isAttained(r.targetValue, r.actualValue, direction),
    });
    groups.set(key, s);
  }
  const series = [...groups.values()]
    .map((s) => ({ ...s, points: s.points.sort((a, b) => a.period.localeCompare(b.period)).slice(-6) }))
    .filter((s) => s.points.length >= 2) // 单期不成历史
    .sort((a, b) => a.deptKey.localeCompare(b.deptKey) || a.metricKey.localeCompare(b.metricKey) || a.periodKind.localeCompare(b.periodKind))
    .slice(0, 24);
  return { periodsPerSeries: 6, series, metricIds: ["goalAttainment"] };
}

/* ───────────────────────── 渠道观察 · 品牌 × 平台 ───────────────────────── */

export interface ChannelPlatformSummary {
  platform: ChannelPlatform;
  state: "ready" | "insufficient";
  grain: string;
  sourceAsOf: string | null;
  anchorDate: string | null;
  units: number | null;
  /** 金额（非价格角色 null；拼多多无金额字段） */
  amount: string | null;
  refundUnits: number | null;
  attribution: { mappedSku: number; shopMaster: number; nameGuess: number; unattributed: number };
  /** 店铺名回退归属占件数比例（%）——猜测比例越高，品牌行越不可靠 */
  nameGuessSharePct: number | null;
  gate: string;
}

export interface ChannelShopRow {
  platform: ChannelPlatform;
  shop: string;
  units: number;
  amount: string | null;
}

export interface ChannelMatrixBlock {
  authority: "observation_only";
  windowDays: number;
  scope: { forced: boolean; channelIds: number[] | null };
  /** 受限渠道账号不下发跨店铺品牌矩阵（null） */
  platforms: ChannelPlatformSummary[] | null;
  brandMatrix: BrandPlatformRow[] | null;
  /** 店铺行：受限账号按人工登记的店铺→渠道映射裁剪，未映射店铺一律剔除 */
  shops: ChannelShopRow[];
  unmappedShops: number;
  limitations: string[];
  metricIds: readonly ["channelBrandUnits", "platformIdentityCoverage"];
}

/* ───────────────────────── 屏2 · 预警命中率（已验证） ───────────────────────── */

/** 真+误 低于此数的分组只给计数不给精确率（小样本百分比会被当成结论） */
export const ALERT_PRECISION_MIN_SAMPLE = 5;
export const ALERT_PRECISION_WINDOW_DAYS = 90;

export interface AlertPrecisionRow extends AlertPrecisionGroup {
  key: string;
  label: string;
  /** 真 + 误（精确率分母，弃权不计） */
  scored: number;
  /** scored < ALERT_PRECISION_MIN_SAMPLE */
  insufficient: boolean;
  /** 样本足够才下发；不足时即使服务层算得出也置 null */
  precisionPct: number | null;
}

export interface AlertPrecisionBlock {
  days: number;
  verifiedTotal: number;
  minSample: number;
  totals: { truePositive: number; falsePositive: number; unverifiable: number };
  groups: AlertPrecisionRow[];
  scoredGroups: number;
  caliber: string;
  metricIds: readonly ["alertPrecision"];
}

export function buildAlertPrecision(summary: AlertPrecisionSummary): AlertPrecisionBlock {
  const totals = { truePositive: 0, falsePositive: 0, unverifiable: 0 };
  const groups: AlertPrecisionRow[] = summary.groups.map((g) => {
    totals.truePositive += g.truePositive;
    totals.falsePositive += g.falsePositive;
    totals.unverifiable += g.unverifiable;
    const scored = g.truePositive + g.falsePositive;
    const insufficient = scored < ALERT_PRECISION_MIN_SAMPLE;
    return {
      ...g,
      key: `${g.category}|${g.sourceRule ?? ""}`,
      label: g.sourceRule ? `${g.category} / ${g.sourceRule}` : g.category,
      scored,
      insufficient,
      precisionPct: insufficient ? null : g.precisionPct,
    };
  });
  return {
    days: summary.days,
    verifiedTotal: summary.verifiedTotal,
    minSample: ALERT_PRECISION_MIN_SAMPLE,
    totals,
    groups,
    scoredGroups: groups.filter((g) => !g.insufficient).length,
    caliber: summary.caliber,
    metricIds: ["alertPrecision"],
  };
}

/* ───────────────────────── 屏4 · 待办完成率（严格口径） ───────────────────────── */

export interface TodoCompletionStrictCell {
  /** 月份（byMonth）/ 角色（byRole）/ "all"（overall） */
  key: string;
  total: number;
  done: number;
  cancelled: number;
  cancelledBySourceClose: number;
  cancelledByHuman: number;
  /** 宽：done ÷ (total − cancelled) */
  completionRate: number | null;
  /** 严：done ÷ (total − cancelledByHuman)——来源自动关闭的待办留在分母 */
  completionRateStrict: number | null;
  /** 宽 − 严（pp）：差距越大，越多"完成"其实是等看门狗把告警关掉 */
  gapPp: number | null;
}

export interface TodoCompletionStrictBlock {
  months: string[];
  byMonth: TodoCompletionStrictCell[];
  /** 按责任角色（证据不排名个人，D61） */
  byRole: TodoCompletionStrictCell[];
  overall: TodoCompletionStrictCell;
  caliber: string;
  metricIds: readonly ["todoCompletionRate", "todoCompletionRateStrict"];
}

function strictCell(key: string, rows: TodoStatsRow[]): TodoCompletionStrictCell {
  const agg = rows.reduce(
    (a, r) => ({
      total: a.total + r.total, done: a.done + r.done, cancelled: a.cancelled + r.cancelled,
      cancelledBySourceClose: a.cancelledBySourceClose + r.cancelledBySourceClose, cancelledByHuman: a.cancelledByHuman + r.cancelledByHuman,
    }),
    { total: 0, done: 0, cancelled: 0, cancelledBySourceClose: 0, cancelledByHuman: 0 },
  );
  const denom = agg.total - agg.cancelled;
  const strictDenom = agg.total - agg.cancelledByHuman;
  // 百分比换算统一走 decimal（与 cockpit.otifRatePctOf 同一实现），不做 float 乘除
  const completionRate = denom > 0 ? ratePctNumOf(dDiv(agg.done, denom, 6)) : null;
  const completionRateStrict = strictDenom > 0 ? ratePctNumOf(dDiv(agg.done, strictDenom, 6)) : null;
  return {
    key, ...agg, completionRate, completionRateStrict,
    gapPp: completionRate != null && completionRateStrict != null ? Number(dSub(completionRate, completionRateStrict, 1)) : null,
  };
}

export function buildTodoCompletionStrict(rows: TodoStatsRow[], months: string[], caliber: string): TodoCompletionStrictBlock {
  const roles = [...new Set(rows.map((r) => r.groupKey))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  return {
    months,
    byMonth: months.map((m) => strictCell(m, rows.filter((r) => r.month === m))),
    byRole: roles.map((role) => strictCell(role, rows.filter((r) => r.groupKey === role))),
    overall: strictCell("all", rows),
    caliber,
    metricIds: ["todoCompletionRate", "todoCompletionRateStrict"],
  };
}

/* ───────────────────────── 屏2 · 供应商集中度与账期（C2） ───────────────────────── */

export interface SupplierConcentrationRow {
  supplierId: number;
  code: string;
  name: string;
  pool: SupplierPool;
  poolLabel: string;
  /** 当年采购额（PO 未税 + JS 结算）；非价格角色 null */
  spend: string | null;
  /** 占当年全部供应商采购额 %（1dp）——**全员可见**：占比不是金额 */
  sharePct: number | null;
  rank: number | null;
  rankTrend: RankTrend;
  cooperationYears: number | null;
  cooperationSource: "system_inferred" | null;
  paymentTermText: string | null;
  attainment: AttainmentStatus;
  /** 同一供应商在 SCM 采购订单读模型里的 OTIF；当年无已批 PO → null（不是 0%） */
  otif: OtifStats | null;
  otifRatePct: number | null;
}

export interface SupplierConcentrationBlock {
  year: number;
  moneyVisible: boolean;
  topN: number;
  /** 前 N 家采购额占比 %（1dp）；总额 0 → null */
  topSharePct: number | null;
  /** 账期类采购额占比（百分数字符串，读模型原值） */
  creditTermSpendSharePct: string | null;
  attainment: { rate: number | null; candidates: number; attained: number };
  rows: SupplierConcentrationRow[];
  suppliersWithSpend: number;
  /** 前 N 家里能在 SCM PO 读模型找到当年 OTIF 的家数 */
  otifMatched: number;
  /** 合作年限为系统推算（非主数据）的家数 */
  cooperationInferred: number;
  link: string;
  metricIds: readonly ["creditTermSpendShare", "paymentTermAttainment", "supplierOtif"];
}

export const SUPPLIER_CONCENTRATION_TOP_N = 5;

/**
 * 供应商集中度 × 账期 × OTIF 交叉。
 * 入参必须是**未剥离金额**的读模型：占比要用真实金额算，算完再按角色决定是否下发金额。
 */
export function buildSupplierConcentration(
  spt: SupplierPaymentTermModel,
  po: PurchaseOrderMetrics | null,
  roles: string[],
): SupplierConcentrationBlock {
  const canSeeMoney = roles.some((r) => (PRICE_VISIBLE_ROLES as readonly string[]).includes(r));
  const year = spt.year;
  const spendOf = (r: SupplierPaymentTermRow): string | null => r.spend.find((s) => s.year === year)?.total ?? null;
  const rankOf = (r: SupplierPaymentTermRow): number | null => r.spend.find((s) => s.year === year)?.rank ?? null;
  const withSpend = spt.rows.filter((r) => dCmp(spendOf(r) ?? "0", 0) > 0);
  // 占比分母取读模型自己的当年总额（与账期占比同分母）；缺失时退回本页可见行合计
  const total = spt.summary.totalSpend ?? withSpend.reduce((acc, r) => dAdd(acc, spendOf(r) ?? "0", 2), "0.00");
  const share = (amount: string | null): number | null =>
    amount == null || dCmp(total, 0) <= 0 ? null : ratePctNumOf(dDiv(amount, total, 6));
  const otifBySupplier = new Map<number, OtifStats>((po?.bySupplier ?? []).map((s) => [s.supplierId, s.otif]));

  const ranked = [...withSpend].sort((a, b) => dCmp(spendOf(b) ?? "0", spendOf(a) ?? "0") || a.code.localeCompare(b.code));
  const top = ranked.slice(0, SUPPLIER_CONCENTRATION_TOP_N);
  const topSpend = top.reduce((acc, r) => dAdd(acc, spendOf(r) ?? "0", 2), "0.00");
  const rows: SupplierConcentrationRow[] = top.map((r) => {
    const otif = otifBySupplier.get(r.supplierId) ?? null;
    return {
      supplierId: r.supplierId,
      code: r.code,
      name: r.name,
      pool: r.pool,
      poolLabel: SUPPLIER_POOL_LABELS[r.pool],
      spend: canSeeMoney ? spendOf(r) : null,
      sharePct: share(spendOf(r)),
      rank: rankOf(r),
      rankTrend: r.rankTrend,
      cooperationYears: r.cooperationYears,
      cooperationSource: r.cooperationSource,
      paymentTermText: r.paymentTermText,
      attainment: r.attainment,
      otif,
      otifRatePct: ratePctNumOf(otif?.rate),
    };
  });

  return {
    year,
    moneyVisible: canSeeMoney,
    topN: SUPPLIER_CONCENTRATION_TOP_N,
    topSharePct: share(topSpend),
    creditTermSpendSharePct: spt.summary.creditTermSpendSharePct,
    attainment: {
      rate: ratePctNumOf(spt.summary.attainmentRate),
      candidates: spt.summary.candidates,
      attained: spt.summary.candidatesAttained,
    },
    rows,
    suppliersWithSpend: withSpend.length,
    otifMatched: rows.filter((r) => r.otif != null).length,
    cooperationInferred: rows.filter((r) => r.cooperationSource === "system_inferred").length,
    link: "/report/supplier-scorecard",
    metricIds: ["creditTermSpendShare", "paymentTermAttainment", "supplierOtif"],
  };
}

/* ───────────────────────── 屏3 · 临期与呆滞（C3） ───────────────────────── */

export interface ExpiryBucketsBlock {
  today: string;
  slowThreshold: number;
  totals: RiskExpiryBucketsModel["totals"];
  brands: RiskExpiryBucketsModel["brands"];
  expirySkus: number;
  slowSkus: number;
  fallbackSkus: number;
  /** 兜底占比 %（fallbackSkus ÷ expirySkus）——段位不是统一口径这件事必须能读出来 */
  fallbackSharePct: number | null;
  /** 观察注记（不定量）：呆滞但外部近 30 天仍在卖 */
  externalNote: { stillSelling: number; withSignal: number };
  link: string;
  metricIds: readonly ["expiryByBrand", "daysCover"];
}

export type { ExpiryBrandRow };

export function buildExpiryBuckets(model: RiskExpiryBucketsModel): ExpiryBucketsBlock {
  return {
    today: model.today,
    slowThreshold: model.slowThreshold,
    totals: model.totals,
    brands: model.brands,
    expirySkus: model.expirySkus,
    slowSkus: model.slowSkus,
    fallbackSkus: model.fallbackSkus,
    fallbackSharePct: model.expirySkus > 0 ? ratePctNumOf(dDiv(model.fallbackSkus, model.expirySkus, 6)) : null,
    externalNote: { stillSelling: model.slowStillSellingExternally, withSignal: model.slowWithExternalSignal },
    link: "/report/risk",
    metricIds: ["expiryByBrand", "daysCover"],
  };
}

/* ───────────────────────── 屏4 · 分层迁移矩阵与试点阻塞漏斗（C5） ───────────────────────── */

export type TierCell = Tier | "未分层";
export const TIER_CELLS: readonly TierCell[] = ["S", "A", "B", "C", "未分层"];

export interface TierMigrationCell {
  from: TierCell;
  to: TierCell;
  skus: number;
}

export interface PilotBlockerRow {
  key: "leadMissing" | "xyzNull" | "xyzNotX" | "detectorHit" | "tierC";
  label: string;
  skus: number;
  hint: string;
  link: string | null;
}

export interface TierMigrationBlock {
  fromPeriod: string | null;
  toPeriod: string | null;
  axes: readonly TierCell[];
  matrix: TierMigrationCell[];
  fromTotals: Record<TierCell, number>;
  toTotals: Record<TierCell, number>;
  scanned: number;
  /**
   * from ≠ to 的 SKU 总数（含进出「未分层」轴）。
   * **单独看它会骗人**：上一期新导入 300 个 SKU，from 全是「未分层」，`moved` 就报「300 个换档」。
   * 页面读数一律用下面三个分项，`moved` 只作 `stayed` 的补数保留。
   */
  moved: number;
  /** 两期都已分层、等级确实变了——这才是「换档」 */
  retiered: number;
  /** 上期未分层、本期分层（新进：新品上架、首次固化） */
  entered: number;
  /** 上期已分层、本期未分层（退出：停用、未参与本期固化） */
  left: number;
  stayed: number;
  /** 试点漏斗（replenish-pilot，键见 PILOT_CACHE_KEY——文案由常量派生，不写死版本号） */
  pilotPeriod: string | null;
  pilotScanned: number;
  candidates: number;
  candidateSalesSharePct: number;
  pilotMarked: number;
  blockers: PilotBlockerRow[];
  links: { pilot: string; supplyParams: string };
  metricIds: readonly ["skuTierShare", "pilotEligible", "leadTimeCoverage"];
}

const emptyTierTotals = (): Record<TierCell, number> => ({ S: 0, A: 0, B: 0, C: 0, "未分层": 0 });

/**
 * 两期固化分层的迁移矩阵（期间 × 期间）。
 *
 * 为什么**不**复用 `rules/abc.tierMigrationMatrix`（现名 `tierBasisAgreementMatrix`）：
 * 那个函数比的是**同一时点的两套口径**（数量分层 vs 金额分层），轴是 Tier × (Tier|null)，
 * 产出 agree / disagree / insufficient——问的是「两把尺子量同一批货，读数一致吗」。
 * 本函数比的是**同一把尺子的两个时点**，轴多一格「未分层」（某期没出现的 SKU 不能假装有分层），
 * 产出 retiered / entered / left——问的是「这批货这一期动档了吗」。
 * 两者语义不同、轴不同、判据不同，硬合并只会造出一个谁都解释不清的矩阵。
 */
export function buildTierMigration(
  periods: { from: string | null; to: string | null },
  tiers: { skuId: number; from: TierCell; to: TierCell }[],
  pilot: PilotReadModel | null,
): TierMigrationBlock {
  const counts = new Map<string, number>();
  const fromTotals = emptyTierTotals();
  const toTotals = emptyTierTotals();
  let moved = 0;
  let retiered = 0;
  let entered = 0;
  let left = 0;
  for (const t of tiers) {
    counts.set(`${t.from}|${t.to}`, (counts.get(`${t.from}|${t.to}`) ?? 0) + 1);
    fromTotals[t.from] += 1;
    toTotals[t.to] += 1;
    if (t.from !== t.to) {
      moved += 1;
      // 只在一期出现的 SKU 不是「换档」：新上架 300 个 SKU 曾被报成「300 个换档」
      const fromUnranked = t.from === "未分层";
      const toUnranked = t.to === "未分层";
      if (fromUnranked && !toUnranked) entered += 1;
      else if (!fromUnranked && toUnranked) left += 1;
      else retiered += 1;
    }
  }
  const matrix: TierMigrationCell[] = [];
  for (const from of TIER_CELLS) {
    for (const to of TIER_CELLS) matrix.push({ from, to, skus: counts.get(`${from}|${to}`) ?? 0 });
  }
  const b = pilot?.blockers;
  // xyzNull 单独成桶（样本不足 ≠ 波动大，绝不并进「非 X」）
  const blockers: PilotBlockerRow[] = [
    { key: "leadMissing", label: "加工/在途周期未维护", skus: b?.leadMissing ?? 0, hint: "主数据缺口：补录后候选立即生效（读模型绑定含 sku_params 更新时刻）", link: "/master/supply-params" },
    { key: "xyzNull", label: "波动样本不足 / 无动销（XYZ 未分类）", skus: b?.xyzUnclassified ?? 0, hint: "样本不足不是「波动大」：单列一桶，不并入「非 X」", link: null },
    { key: "xyzNotX", label: "需求波动非 X", skus: b?.xyzNotX ?? 0, hint: "需求本身不稳，是业务事实不是主数据缺口", link: null },
    { key: "detectorHit", label: "异动侦测命中", skus: b?.detectorHit ?? 0, hint: "异动期间不自动直出，等异动消解后复判", link: "/replenish/pilot" },
    { key: "tierC", label: "C 级长尾", skus: b?.tierC ?? 0, hint: "C 级按设计走运营按需，本就不进试点", link: null },
  ];
  return {
    fromPeriod: periods.from,
    toPeriod: periods.to,
    axes: TIER_CELLS,
    matrix,
    fromTotals,
    toTotals,
    scanned: tiers.length,
    moved,
    retiered,
    entered,
    left,
    stayed: tiers.length - moved,
    pilotPeriod: pilot?.period ?? null,
    pilotScanned: pilot?.scanned ?? 0,
    candidates: pilot?.candidates ?? 0,
    candidateSalesSharePct: pilot?.candidateSalesSharePct ?? 0,
    pilotMarked: pilot?.pilotMarked ?? 0,
    blockers,
    links: { pilot: "/replenish/pilot", supplyParams: "/master/supply-params" },
    metricIds: ["skuTierShare", "pilotEligible", "leadTimeCoverage"],
  };
}

/** 两个最新固化期的生效分层（人工覆写优先）；不足两期 → periods.from = null，块置 insufficient */
export async function loadTierMigration(
  db: AnyDb,
): Promise<{ periods: { from: string | null; to: string | null }; tiers: { skuId: number; from: TierCell; to: TierCell }[] }> {
  const periodRows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT period FROM sku_planning_policy GROUP BY period ORDER BY period DESC LIMIT 2`));
  const to = periodRows[0]?.period == null ? null : String(periodRows[0].period);
  const from = periodRows[1]?.period == null ? null : String(periodRows[1].period);
  if (!to || !from) return { periods: { from, to }, tiers: [] };
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT sku_id, period, coalesce(override_tier, tier) AS tier
    FROM sku_planning_policy WHERE period IN (${from}, ${to})`));
  const bySku = new Map<number, { from: TierCell; to: TierCell }>();
  for (const r of rows) {
    const skuId = n0(r.sku_id);
    const raw = String(r.tier ?? "");
    const cell: TierCell = (TIER_CELLS as readonly string[]).includes(raw) ? (raw as TierCell) : "未分层";
    const cur = bySku.get(skuId) ?? { from: "未分层" as TierCell, to: "未分层" as TierCell };
    if (String(r.period ?? "") === from) cur.from = cell;
    else cur.to = cell;
    bySku.set(skuId, cur);
  }
  return { periods: { from, to }, tiers: [...bySku.entries()].map(([skuId, v]) => ({ skuId, ...v })) };
}

/* ────────────────── 屏1 · 数据新鲜度趋势（C6）/ 屏4 · 数据质量趋势（B8） ────────────────── */

export interface SourceTrendBlock {
  weeks: string[];
  windowWeeks: number;
  minWeeks: number;
  series: SourceClassSeries[];
  /** 周数足够、可出趋势的来源类数 */
  readySeries: number;
  link: string;
  metricIds: readonly string[];
}

/**
 * `readySeries` 必须按**这张图实际画的那条读数**判定（审计 C8b）：
 * 只看「有没有运行」，会让「有运行但一个批次都没有业务截止日」的来源顶着 ready 的 chip
 * 渲染一张空图。及时性图看 `ageState`，放行率图看 `passRateState`。
 */
function sourceTrendBlock(
  history: SourceRunHistory,
  metricIds: readonly string[],
  readyOf: (s: SourceClassSeries) => boolean,
): SourceTrendBlock {
  return {
    weeks: history.weeks,
    windowWeeks: history.windowWeeks,
    minWeeks: history.minWeeks,
    series: history.series,
    readySeries: history.series.filter(readyOf).length,
    link: "/import/data-quality",
    metricIds,
  };
}

export function buildDataFreshnessTrend(history: SourceRunHistory): SourceTrendBlock {
  return sourceTrendBlock(history, ["dataFreshnessAgeDays"], (s) => s.ageState === "ready");
}

export function buildDataQualityTrend(history: SourceRunHistory): SourceTrendBlock {
  return sourceTrendBlock(history, ["dataQualityPassRate"], (s) => s.passRateState === "ready");
}

/* ───────────────────────── 装配 ───────────────────────── */

export interface CockpitTrendsData {
  generatedAt: string;
  today: string;
  calibreVersion: typeof COCKPIT_TRENDS_CALIBRE;
  screens: {
    s1: { dailyFlow: Block<DailyFlowBlock>; freshnessTrend: Block<SourceTrendBlock> };
    s2: { poTrend: Block<PoTrendBlock>; externalDemand: Block<ExternalDemandBriefBlock>; quadrant: Block<QuadrantBlock>; alertPrecision: Block<AlertPrecisionBlock>; supplierConcentration: Block<SupplierConcentrationBlock> };
    s3: { turnoverWindows: Block<TurnoverWindowsBlock>; expiryBuckets: Block<ExpiryBucketsBlock> };
    s4: { todoThroughput: Block<TodoThroughputBlock>; todoCompletionStrict: Block<TodoCompletionStrictBlock>; alertLifecycle: Block<AlertLifecycleBlock>; goalHistory: Block<GoalHistoryBlock>; tierMigration: Block<TierMigrationBlock>; dataQualityTrend: Block<SourceTrendBlock> };
    channels: { brandMatrix: Block<ChannelMatrixBlock> };
  };
  limitations: string[];
}

function settled<T>(r: PromiseSettledResult<T>): { ok: true; value: T } | { ok: false; error: string } {
  return r.status === "fulfilled" ? { ok: true, value: r.value } : { ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
}
const errorBlock = <T,>(error: string, source: string, tier: CockpitSource["tier"] = "derived"): Block<T> =>
  ({ state: "error", data: null, note: error, source: { tier, source, asOf: null } });
const noAccess = <T,>(note: string, source: string): Block<T> =>
  ({ state: "no_access", data: null, note, source: { tier: "observation", source, asOf: null } });

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export async function getCockpitTrends(user: SessionUser, dbArg?: AnyDb, opts: { now?: Date } = {}): Promise<CockpitTrendsData> {
  const db = await resolveDb(dbArg);
  const now = opts.now ?? new Date();
  const today = todayShanghai(now);
  const roles = user.roles;
  const canSeeMoney = roles.some((r) => (PRICE_VISIBLE_ROLES as readonly string[]).includes(r));
  const channelScope = resolveChannelScope(user, null);
  const thisMonth = monthShanghai(now);
  const currentYear = Number(today.slice(0, 4));

  const [
    posR, poR, poPrevR, demandR, alertsR, velR, slowR, wh30R, wh90R, wh365R, todoR, alertLifeR, goalsR, channelR, precisionR,
    sptR, expiryR, tierR, pilotR, runHistoryR,
  ] = await Promise.allSettled([
    loadInventoryPosition(db),
    loadPurchaseOrderMetrics({}, db),
    // 历史年份即时计算不缓存：只为补足 12 个月窗口；失败不影响当年趋势
    thisMonth.endsWith("-12") ? Promise.resolve(null) : loadPurchaseOrderMetrics({ year: currentYear - 1 }, db),
    channelScope.forced ? Promise.resolve(null) : loadJiandaoyunExternalDemandSignal(db),
    channelScope.forced ? Promise.resolve(null) : loadInventoryAlerts(db),
    channelScope.forced ? Promise.resolve(null) : loadExternalVelocitySafe(db),
    getNumParam("slow_days_threshold", 180, db),
    loadWarehouseInventory(db, { windowDays: WAREHOUSE_WINDOWS[0] }),
    loadWarehouseInventory(db, { windowDays: WAREHOUSE_WINDOWS[1] }),
    loadWarehouseInventory(db, { windowDays: WAREHOUSE_WINDOWS[2] }),
    getTodoStats({ groupBy: "role", fromMonth: shiftMonth(thisMonth, -5), toMonth: thisMonth, now }, user, db),
    loadAlertLifecycle(db),
    loadGoalHistory(db, user),
    loadChannelObservation(db),
    alertPrecision(db, { days: ALERT_PRECISION_WINDOW_DAYS, now }),
    // BI wave 2：供应商账期（C2）、临期与呆滞（C3）、分层迁移与试点漏斗（C5）、来源运行史（C6 + B8）
    loadSupplierPaymentTerm(db),
    loadRiskExpiryBuckets(db),
    loadTierMigration(db),
    loadReplenishPilot(db),
    loadSourceRunHistory(db, { today }),
  ]);

  /* 屏1 */
  const pos = settled(posR);
  const dailyFlow: Block<DailyFlowBlock> = pos.ok
    ? (() => {
        const b = buildDailyFlow(pos.value.daily);
        const hasData = b.points.some((p) => p.realtimeOut != null || p.snapshotOut != null);
        return {
          state: hasData ? "ready" : "insufficient",
          data: b,
          note: hasData ? "实时仓（流水）与快照仓（相邻快照差分）两条序列并列显示，绝不相加；快照差分跨多日为累计值" : "当月尚无流水或快照差分",
          source: { tier: "snapshot", source: `${INVENTORY_POSITION_CACHE_KEY} · daily`, asOf: pos.value.builtAt },
        };
      })()
    : errorBlock(`${INVENTORY_POSITION_CACHE_KEY} 读取失败：${pos.error}`, INVENTORY_POSITION_CACHE_KEY, "snapshot");

  /* 屏2 */
  const po = settled(poR);
  const poPrev = settled(poPrevR);
  const poTrend: Block<PoTrendBlock> = po.ok
    ? (() => {
        const b = buildPoTrend(po.value, poPrev.ok ? poPrev.value : null, roles);
        const hasData = b.points.some((p) => p.poCount > 0);
        return {
          state: hasData ? "ready" : "insufficient",
          data: b,
          note: `${canSeeMoney ? "" : "金额仅价格可见角色；"}当月进行中置灰；OTIF 改用逐月口径（有可评样本的月份 ${b.monthsWithOtif}/${b.points.length}，可评 n 随点标注；近月 PO 多半未到承诺日、结构性偏低），年度累计 ${b.otifYtd.year} 年可评 n=${b.otifYtd.evaluable} 并列作对照${poPrev.ok ? "" : `；上一年度即时计算失败（${poPrev.error}）`}`,
          source: { tier: "fact", source: `${PURCHASE_ORDER_METRICS_KEY} · byMonth.otif`, asOf: po.value.builtAt },
        };
      })()
    : errorBlock(po.error, PURCHASE_ORDER_METRICS_KEY, "fact");

  const demand = settled(demandR);
  const externalDemand: Block<ExternalDemandBriefBlock> = channelScope.forced
    ? noAccess("受限渠道范围不下发跨店铺的外部平台观察（D62）", EXTERNAL_DEMAND_SIGNAL_CACHE_KEY)
    : demand.ok && demand.value
      ? (() => {
          const { block, sufficient } = buildExternalDemandBrief(demand.value.decisionBrief);
          return {
            state: sufficient ? "ready" : "insufficient",
            data: block,
            note: sufficient ? `观察口径：只给方向与百分比，不进补货数量；窗口 ${block.current.startDate} → ${block.current.endDate} vs 前 7 日` : `${block.gate}（当前窗口观察 ${block.current.observedDays}/${block.current.requiredDays} 天，前窗口 ${block.previous.observedDays}/${block.previous.requiredDays} 天）`,
            source: { tier: "observation", source: `${EXTERNAL_DEMAND_SIGNAL_CACHE_KEY} · decisionBrief（天猫，T+1）`, asOf: demand.value.sourceAsOf },
          };
        })()
      : errorBlock(demand.ok ? "无数据" : demand.error, EXTERNAL_DEMAND_SIGNAL_CACHE_KEY, "observation");

  const alerts = settled(alertsR);
  const vel = settled(velR);
  const slow = settled(slowR);
  const quadrant: Block<QuadrantBlock> = channelScope.forced
    ? noAccess("受限渠道范围不下发 SKU 级外部观察（D62）", `${INVENTORY_ALERTS_CACHE_KEY} × ${EXTERNAL_VELOCITY_CACHE_KEY}`)
    : alerts.ok && alerts.value && vel.ok && vel.value
      ? (() => {
          const b = buildQuadrant(alerts.value, vel.value, slow.ok ? slow.value : 180);
          const ready = vel.value.state === "ready" && b.points.length > 0;
          return {
            state: ready ? "ready" : "insufficient",
            data: b,
            note: ready
              ? `已映射 ${b.coverage.mappedRows} / 预警表 ${b.coverage.alertRows} 个 SKU（未映射 ${b.coverage.unmappedRows} 个排除，不按 0 处理）；纵轴仅天猫（拼多多未接入）；断货 = 可销 ≤ 阈值且外部有动销，呆滞 = 可销 ≥ ${b.thresholds.slowDays} 天且外部 30 天无动销`
              : vel.value.state !== "ready" ? vel.value.gate : "预警表与外部销速尚无可交叉的已映射 SKU",
            source: { tier: "observation", source: `${INVENTORY_ALERTS_CACHE_KEY} × ${EXTERNAL_VELOCITY_CACHE_KEY}（观察只预警不定量）`, asOf: vel.value.sourceAsOf ?? alerts.value.builtAt },
          };
        })()
      : errorBlock(alerts.ok ? (vel.ok ? "无数据" : vel.error) : alerts.error, `${INVENTORY_ALERTS_CACHE_KEY} × ${EXTERNAL_VELOCITY_CACHE_KEY}`, "observation");

  const precision = settled(precisionR);
  const alertPrecisionBlock: Block<AlertPrecisionBlock> = precision.ok
    ? (() => {
        const b = buildAlertPrecision(precision.value);
        const ready = b.verifiedTotal > 0;
        return {
          state: ready ? "ready" : "insufficient",
          data: b,
          note: ready
            ? `弃权不进分母；真+误 < ${b.minSample} 的分组只给计数不给精确率（可评分组 ${b.scoredGroups}/${b.groups.length}）；每条告警只核验一次，结果只进台账、不回写告警、不自动调阈值`
            : `近 ${b.days} 天没有已核验的告警：核验任务在告警关闭 ≥ 3 天后回看实时仓流水，快照仓 SKU 无流水只能弃权`,
          source: { tier: "fact", source: `alert_events(verify) × system_alerts（${ALERT_OUTCOME_VERSION}）`, asOf: now.toISOString() },
        };
      })()
    : errorBlock(precision.error, "alert_events(verify)", "fact");

  /* 屏3 */
  const whs = [wh30R, wh90R, wh365R].map(settled);
  const okModels = whs.filter((w): w is { ok: true; value: WarehouseInventoryModel } => w.ok).map((w) => w.value);
  const whErrors = whs.filter((w): w is { ok: false; error: string } => !w.ok).map((w) => w.error);
  const turnoverWindows: Block<TurnoverWindowsBlock> = okModels.length
    ? (() => {
        const b = buildTurnoverWindows(okModels, pos.ok ? pos.value.ledgerFirstDay : null);
        const rows = b.rows.map((r) => ({ ...r }));
        const hasTurns = b.summary.some((c) => !c.suppressed) || rows.some((r) => r.windows.some((c) => !c.suppressed));
        return {
          state: hasTurns ? "ready" : "insufficient",
          data: { ...b, rows },
          note: `${hasTurns ? "短窗口噪声更大，窗口覆盖不完整或零出库时压制不显示" : "三个窗口均无可计算周转（无实时仓出库或流水覆盖不足）"}${whErrors.length ? `；部分窗口读取失败：${whErrors.join("；")}` : ""}`,
          source: { tier: "snapshot", source: `${WAREHOUSE_INVENTORY_CACHE_KEY} · w${b.windows.join("/w")}`, asOf: okModels[0].builtAt },
        };
      })()
    : errorBlock(whErrors.join("；"), WAREHOUSE_INVENTORY_CACHE_KEY, "snapshot");

  /* 屏4 */
  const todo = settled(todoR);
  const trendMonths = Array.from({ length: 6 }, (_, i) => shiftMonth(thisMonth, i - 5));
  const todoThroughput: Block<TodoThroughputBlock> = todo.ok
    ? (() => {
        const rolesSeen = [...new Set(todo.value.rows.map((r) => r.groupKey))].sort((a, b) => a.localeCompare(b, "zh-CN"));
        return {
          state: todo.value.rows.length ? "ready" : "insufficient",
          data: { months: trendMonths, roles: rolesSeen.length ? rolesSeen : [...ROLES], rows: todo.value.rows, caliber: todo.value.caliber, metricIds: ["todoCompletionRate"] },
          note: todo.value.rows.length ? "证据不打分：按责任角色 × 创建月，不排名个人（D61）" : "近 6 个月没有系统来源（预警/复核）的待办",
          source: { tier: "fact", source: "work_items（todo/stats 按月）", asOf: now.toISOString() },
        };
      })()
    : errorBlock(todo.error, "work_items", "fact");

  const todoCompletionStrict: Block<TodoCompletionStrictBlock> = todo.ok
    ? (() => {
        const b = buildTodoCompletionStrict(todo.value.rows, trendMonths, todo.value.caliber);
        const ready = b.overall.total > 0;
        return {
          state: ready ? "ready" : "insufficient",
          data: b,
          note: ready
            ? `严口径把「来源告警被引擎自动关闭而取消」的待办留在分母（等看门狗把告警关掉不算完成）；宽 − 严 = ${b.overall.gapPp ?? "—"} pp；按角色 × 月看证据，不排名个人（D61）`
            : "近 6 个月没有系统来源（预警/复核）的待办",
          source: { tier: "fact", source: "work_items × system_alerts.auto_resolved（todo/stats 按月）", asOf: now.toISOString() },
        };
      })()
    : errorBlock(todo.error, "work_items", "fact");

  const alertLife = settled(alertLifeR);
  const alertLifecycle: Block<AlertLifecycleBlock> = alertLife.ok
    ? {
        state: alertLife.value.total > 0 ? "ready" : "insufficient",
        data: alertLife.value,
        note: alertLife.value.total > 0 ? `知悉不改变状态（ack ≠ 关闭），知悉时长与关闭时长分开统计（近 ${alertLife.value.latency.windowDays} 天创建的告警）；自动关闭 = 引擎迟滞关闭` : "尚无系统告警",
        source: { tier: "fact", source: "system_alerts（created/acked/resolved/dedupe_key/source_rule）", asOf: now.toISOString() },
      }
    : errorBlock(alertLife.error, "system_alerts", "fact");

  const goals = settled(goalsR);
  const goalHistory: Block<GoalHistoryBlock> = goals.ok
    ? {
        state: goals.value.series.length ? "ready" : "insufficient",
        data: goals.value,
        note: goals.value.series.length ? "只读历史期间的登记值，不用当前读模型回填缺失的历史实际值" : "同一部门 × 指标不足 2 个期间，尚不成历史",
        source: { tier: "manual", source: "department_goals（逐期登记）", asOf: now.toISOString() },
      }
    : errorBlock(goals.error, "department_goals", "manual");

  /* 渠道观察 */
  const channel = settled(channelR);
  let brandMatrix: Block<ChannelMatrixBlock>;
  if (!channel.ok) {
    brandMatrix = errorBlock(channel.error, CHANNEL_OBSERVATION_CACHE_KEY, "observation");
  } else {
    const obs = channel.value;
    const allShops: ChannelShopRow[] = obs.platforms.flatMap((p) => p.byShop.map((s) => ({ platform: p.platform, shop: s.shop, units: s.units, amount: canSeeMoney ? s.amount : null })));
    let shops = allShops;
    let unmappedShops = 0;
    if (channelScope.forced) {
      const map = await loadShopChannelMap(db, allShops.map((s) => s.shop));
      shops = filterShopRowsByChannelScope(allShops, (s) => s.shop, map, { channelIds: channelScope.channelIds });
      unmappedShops = map.unmapped.length;
    }
    const platforms: ChannelPlatformSummary[] | null = channelScope.forced ? null : obs.platforms.map((p) => {
      const a = p.brandAttribution;
      const total = a.mappedSku + a.shopMaster + a.nameGuess + a.unattributed;
      return {
        platform: p.platform, state: p.state, grain: p.grain, sourceAsOf: p.sourceAsOf, anchorDate: p.anchorDate,
        units: p.units, amount: canSeeMoney ? p.amount : null, refundUnits: p.refundUnits, attribution: a,
        nameGuessSharePct: total > 0 ? Math.round((a.nameGuess / total) * 1000) / 10 : null, gate: p.gate,
      };
    });
    const matrix: BrandPlatformRow[] | null = channelScope.forced ? null : obs.brandMatrix.map((r) => ({
      ...r,
      platforms: Object.fromEntries(Object.entries(r.platforms).map(([k, v]) => [k, { units: v.units, amount: canSeeMoney ? v.amount : null }])) as BrandPlatformRow["platforms"],
    }));
    const ready = channelScope.forced ? shops.length > 0 : obs.platforms.some((p) => p.state === "ready");
    brandMatrix = {
      state: ready ? "ready" : "insufficient",
      data: {
        authority: "observation_only", windowDays: obs.windowDays,
        scope: { forced: channelScope.forced, channelIds: channelScope.channelIds },
        platforms, brandMatrix: matrix, shops, unmappedShops, limitations: obs.limitations,
        metricIds: ["channelBrandUnits", "platformIdentityCoverage"],
      },
      note: channelScope.forced
        ? (ready ? `只显示映射到本渠道范围的店铺行（未映射店铺 ${unmappedShops} 个已剔除）；跨店铺品牌矩阵不下发（D62）` : "本渠道范围内没有已登记映射的店铺（店铺→渠道映射需人工登记）")
        : (ready ? "件数按各平台口径并列，不跨平台相加；品牌归属含店铺名回退猜测，猜测占比随行标注" : obs.platforms.map((p) => p.gate).filter(Boolean).join("；") || "三平台观察均无可用批次"),
      source: { tier: "observation", source: `${CHANNEL_OBSERVATION_CACHE_KEY} · brandMatrix（近 30 天）`, asOf: obs.platforms.map((p) => p.sourceAsOf).filter(Boolean).sort().at(-1) ?? null },
    };
  }

  /* BI wave 2 · C2 供应商集中度 × 账期 × OTIF */
  const spt = settled(sptR);
  const supplierConcentration: Block<SupplierConcentrationBlock> = spt.ok
    ? (() => {
        // 金额未剥离的读模型进 build（占比要用真实金额算），build 内部按角色决定是否下发金额
        const b = buildSupplierConcentration(spt.value, po.ok ? po.value : null, roles);
        const ready = b.rows.length > 0;
        return {
          state: ready ? "ready" : "insufficient",
          data: b,
          note: ready
            ? `占比全员可见、金额仅价格可见角色；合作年限由最早已批 PO/JG 系统推算（cooperationSource=system_inferred，${b.cooperationInferred}/${b.rows.length} 家），不是主数据；账期类采购额占比是采购/结算口径的代理指标，不是应付余额；前 ${b.topN} 家中 ${b.otifMatched} 家能在 SCM 采购订单读模型找到当年 OTIF，其余当年无已批 PO（留空不写 0%）`
            : `${b.year} 年尚无供应商采购额（PO 未税 + JS 结算均为 0）`,
          source: { tier: "fact", source: `${SUPPLIER_PAYMENT_TERM_KEY} × ${PURCHASE_ORDER_METRICS_KEY} · bySupplier（${b.year} 年）`, asOf: spt.value.builtAt },
        };
      })()
    : errorBlock(spt.error, SUPPLIER_PAYMENT_TERM_KEY, "fact");

  /* BI wave 2 · C3 临期与呆滞 */
  const expiry = settled(expiryR);
  const expiryBuckets: Block<ExpiryBucketsBlock> = expiry.ok
    ? (() => {
        const b = buildExpiryBuckets(expiry.value);
        const ready = b.expirySkus > 0 || b.slowSkus > 0;
        return {
          state: ready ? "ready" : "insufficient",
          data: b,
          note: ready
            ? `段位按批次剩余天数统一刻度（已过期 / ≤30 / 31–60 / 61–90），> 90 天不入桶；其中 ${b.fallbackSkus} 个 SKU（${b.fallbackSharePct ?? "—"}%）的临期阈值走 90 天兜底，段位并非逐 SKU 统一口径；数量取 batch_stocks（效期盘点载体，不是账本）；外部近 30 天仍在卖 ${b.externalNote.stillSelling}/${b.externalNote.withSignal} 个呆滞 SKU 仅为观察注记，不驱动处置数量`
            : "没有带效期的在库批次，也没有滞销关注 SKU",
          source: { tier: "snapshot", source: `${RISK_EXPIRY_BUCKETS_KEY}（batch_stocks × skus.near_expiry_days × 风险工作台）`, asOf: expiry.value.builtAt },
        };
      })()
    : errorBlock(expiry.error, RISK_EXPIRY_BUCKETS_KEY, "snapshot");

  /* BI wave 2 · C5 分层迁移矩阵 + 试点阻塞漏斗 */
  const tier = settled(tierR);
  const pilot = settled(pilotR);
  const tierMigration: Block<TierMigrationBlock> = tier.ok
    ? (() => {
        const b = buildTierMigration(tier.value.periods, tier.value.tiers, pilot.ok ? pilot.value : null);
        const ready = b.fromPeriod != null && b.scanned > 0;
        return {
          state: ready ? "ready" : "insufficient",
          data: b,
          note: ready
            ? `${b.fromPeriod} → ${b.toPeriod} 两期固化分层对比（人工覆写优先）：${b.retiered} 个 SKU 换档、${b.stayed} 个不变；另有 ${b.entered} 个本期新进分层、${b.left} 个退出分层——只在某一期出现的 SKU 落在「未分层」轴，不并进「换档」也不假装分层。试点阻塞按维度并列，一个 SKU 可同时命中多项——不相加${pilot.ok ? "" : `；试点读模型读取失败（${pilot.error}），漏斗计数为 0`}`
            : b.toPeriod == null ? "尚未固化任何期间的分层（sku_planning_policy 为空），无法比较" : `只有 ${b.toPeriod} 一期固化分层，迁移需要两期`,
          source: { tier: "derived", source: `sku_planning_policy（两期固化）× ${PILOT_CACHE_KEY} · blockers`, asOf: pilot.ok ? pilot.value.builtAt : null },
        };
      })()
    : errorBlock(tier.error, "sku_planning_policy", "derived");

  /* BI wave 2 · C6 数据新鲜度趋势 / B8 数据质量趋势（同一份运行史） */
  const runHistory = settled(runHistoryR);
  const freshnessTrend: Block<SourceTrendBlock> = runHistory.ok
    ? (() => {
        const b = buildDataFreshnessTrend(runHistory.value);
        return {
          state: b.readySeries > 0 ? "ready" : "insufficient",
          data: b,
          note: b.readySeries > 0
            ? `每周读数 = 该周最陈旧的一次入库（收到日 − 业务截止日 source_as_of），没有业务截止日的批次不参与、不按 0 处理；${b.readySeries}/${b.series.length} 类来源满足 ${b.minWeeks} 周**有及时性读数**的门槛（有运行但无业务截止日不算），其余按不足展示不画线`
            : `近 ${b.windowWeeks} 周各来源类都不足 ${b.minWeeks} 周有「收到日 − 业务截止日」读数，两个点连成的线不叫趋势`,
          source: { tier: "fact", source: "import_jobs × integration_runs（近 8 周，按 D65 来源类）", asOf: runHistory.value.builtAt },
        };
      })()
    : errorBlock(runHistory.error, "import_jobs × integration_runs", "fact");

  const dataQualityTrend: Block<SourceTrendBlock> = runHistory.ok
    ? (() => {
        const b = buildDataQualityTrend(runHistory.value);
        return {
          state: b.readySeries > 0 ? "ready" : "insufficient",
          data: b,
          note: b.readySeries > 0
            ? `放行率 = Σok_rows ÷ (Σok_rows + Σfail_rows)，与「人工单据链准确率」同一代理口径（首次通过率，不是单据本身对不对）；分母为 0 的周留空不按 100%（也因此不计入门槛）；并列该周失败运行数；不新建历史表，全部由既有运行史推导`
            : `近 ${b.windowWeeks} 周各来源类都不足 ${b.minWeeks} 周有放行率读数（只跑不落行的周留空）`,
          source: { tier: "fact", source: "import_jobs（ok/fail 行）× integration_runs（失败运行），近 8 周", asOf: runHistory.value.builtAt },
        };
      })()
    : errorBlock(runHistory.error, "import_jobs × integration_runs", "fact");

  return {
    generatedAt: now.toISOString(),
    today,
    calibreVersion: COCKPIT_TRENDS_CALIBRE,
    screens: {
      s1: { dailyFlow, freshnessTrend },
      s2: { poTrend, externalDemand, quadrant, alertPrecision: alertPrecisionBlock, supplierConcentration },
      s3: { turnoverWindows, expiryBuckets },
      s4: { todoThroughput, todoCompletionStrict, alertLifecycle, goalHistory, tierMigration, dataQualityTrend },
      channels: { brandMatrix },
    },
    limitations: [
      "趋势块只装配唯一权威读模型的时间维与交叉维，不在本页重算口径；每块自带来源、时点与限制。",
      "简道云观察序列只给方向与百分比，不下发件数，不进补货数量；受限渠道账号不下发跨店铺聚合。",
      "金额对非价格角色在服务层剥离，路由出口再经 maskSensitive 兜底。",
    ],
  };
}
