/**
 * 决策工作室：把 E7-07~19 中当前事实能够支撑的分析收口为一个只读服务。
 *
 * 纪律：
 * - 月度分析只读 sales_monthly；日级热力只读受控 JST staging，不把待解析行伪装成已映射事实；
 * - 所有聚合在全量服务端事实上完成，客户端分页/筛选不参与口径；
 * - 同比、SPC、日级归因不满足前提时返回明确 gate，不用 0 或演示数据补位；
 * - 跨 SKU 数量直加只用于结构与趋势，不代表收入、利润或统一实物量。
 * - D62：渠道维按 `core/data-scope` 解析结果裁剪——受限用户的月度事实强制加 channel_id 条件，
 *   越权渠道 403；JST 日事实没有渠道维度，受限用户一律 gate 不呈现。
 */
import { and, inArray, sql } from "drizzle-orm";

import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { num } from "@/server/core/svc";
import {
  channelScopeCondition,
  resolveChannelScopeByCode,
  UNRESTRICTED_SCOPE,
  type ResolvedChannelScope,
} from "@/server/modules/report/channel-scope";
import { detectSignals, type SpcResult } from "@/server/rules/spc";
import {
  emptyExternalDemandSignal,
  loadJiandaoyunExternalDemandSignal,
  type ExternalDemandSignal,
} from "@/server/modules/report/external-demand-signal";
import {
  emptyCommerceIdentityCoverage,
  loadCommerceIdentityCoverage,
  type CommerceIdentityCoverage,
} from "@/server/modules/report/commerce-identity-coverage";
import {
  loadDataSourceReadiness,
  type DataSourceReadiness,
} from "@/server/modules/report/data-source-readiness";
import {
  loadDataProductReleaseReadiness,
  type DataProductReleaseReadiness,
} from "@/server/modules/report/data-product-release";
import {
  loadDataProductOutcomeReadiness,
  type DataProductOutcomeReadiness,
} from "@/server/modules/report/data-product-outcome";
import {
  loadJiandaoyunSupportingObservations,
  type JiandaoyunSupportingObservation,
} from "@/server/modules/report/jiandaoyun-supporting-observation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export type StudioDimension = "brand" | "channel" | "sku" | "month";
export type StudioSection = "core" | "daily" | "external" | "identity" | "readiness";

/**
 * 跨维筛选范围。与 `dimension`（分组维度）**正交**：
 * dimension 决定"按什么分组"，scope 决定"看哪一部分数据"。
 * 0727 会议要的「NING × 天猫」这类组合此前做不到——旧实现只有一个
 * dimension + 一个 key，品牌与渠道互斥单选。
 */
export interface StudioScope {
  /** 品牌 code；未分配品牌用 "(unassigned)" */
  brand?: string;
  /** 渠道 code */
  channel?: string;
}

export interface StudioQuery {
  dimension?: StudioDimension;
  key?: string;
  scope?: StudioScope;
  /**
   * 页面按当前标签页只取所需读模型，避免首屏串行等待外部证据与发布门禁。
   * 省略时保留完整结果，供通知任务、测试和其他服务端调用使用。
   */
  sections?: StudioSection[];
}

export interface MonthlyGroupFact {
  month: string;
  key: string;
  label: string;
  qty: number;
}

export interface DailyFact {
  importJobId: number;
  status: "pending" | "validated" | "committed";
  bizDate: string;
  skuCode: string;
  qty: number;
  skuId: number | null;
}

export interface DecisionStudioResult {
  generatedAt: string;
  loadedSections: StudioSection[];
  /** D62：渠道范围裁剪结果；forced=true 时页面把渠道筛选改为只读标签 */
  channelScope: { forced: boolean; channelIds: number[] | null; label: string | null };
  dimension: StudioDimension;
  selectedKey: string | null;
  selectedLabel: string | null;
  months: string[];
  latestMonth: string | null;
  groups: { key: string; label: string; total: number }[];
  monthly: {
    month: string;
    qty: number;
    upper3: number | null;
    lower3: number | null;
  }[];
  comparison: {
    current: number | null;
    previous: number | null;
    momPct: number | null;
    yearAgo: number | null;
    yoyPct: number | null;
    yoyGate: string | null;
  };
  pareto: {
    key: string;
    label: string;
    qty: number;
    sharePct: number;
    cumulativePct: number;
  }[];
  /** Null when the latest month has no positive total to use as a denominator. */
  pareto80Count: number | null;
  medianQty: number | null;
  pivot: { key: string; label: string; total: number; byMonth: Record<string, number> }[];
  spc: SpcResult;
  daily: {
    state: "ready" | "insufficient";
    gate: string | null;
    dates: { date: string; qty: number }[];
    coveredRows: number;
    totalRows: number;
    latestDate: string | null;
  };
  externalDemand: ExternalDemandSignal;
  commerceIdentity: CommerceIdentityCoverage;
  dataSources: DataSourceReadiness[];
  dataProductReleases: DataProductReleaseReadiness[];
  dataProductOutcomes: DataProductOutcomeReadiness[];
  supportingObservations: JiandaoyunSupportingObservation[];
  review: {
    headline: string;
    bullets: string[];
    markdown: string;
  };
  limitations: string[];
}

const DIMENSIONS: StudioDimension[] = ["brand", "channel", "sku", "month"];
const NO_BRAND = "(unassigned)";

const DIMENSION_LABELS: Record<StudioDimension, string> = {
  brand: "品牌", channel: "渠道", sku: "SKU", month: "月份",
};
const SPC_MIN_MONTHS = 12;
const PIVOT_GROUP_LIMIT = 20;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2);
}

function previousYearMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  return `${year - 1}${month.slice(4)}`;
}

function aggregateFacts(facts: MonthlyGroupFact[]): MonthlyGroupFact[] {
  const map = new Map<string, MonthlyGroupFact>();
  for (const fact of facts) {
    const id = `${fact.month}\u0000${fact.key}`;
    const current = map.get(id);
    if (current) current.qty += fact.qty;
    else map.set(id, { ...fact });
  }
  return [...map.values()].map((item) => ({ ...item, qty: round(item.qty, 4) }));
}

export function buildDecisionStudio(
  rawFacts: MonthlyGroupFact[],
  rawDaily: DailyFact[],
  query: StudioQuery = {},
  externalDemand: ExternalDemandSignal = emptyExternalDemandSignal(),
  commerceIdentity: CommerceIdentityCoverage = emptyCommerceIdentityCoverage(),
  dataSources: DataSourceReadiness[] = [],
): DecisionStudioResult {
  const dimension = DIMENSIONS.includes(query.dimension as StudioDimension)
    ? (query.dimension as StudioDimension)
    : "brand";
  const facts = aggregateFacts(rawFacts);
  const months = [...new Set(facts.map((item) => item.month))].sort();
  const latestMonth = months.at(-1) ?? null;

  const totalsByGroup = new Map<string, { label: string; total: number }>();
  for (const item of facts) {
    const group = totalsByGroup.get(item.key) ?? { label: item.label, total: 0 };
    group.total += item.qty;
    totalsByGroup.set(item.key, group);
  }
  const groups = [...totalsByGroup.entries()]
    .map(([key, value]) => ({ key, label: value.label, total: round(value.total, 4) }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "zh-CN"));
  const selectedKey = query.key && totalsByGroup.has(query.key) ? query.key : null;
  const selectedLabel = selectedKey ? totalsByGroup.get(selectedKey)?.label ?? selectedKey : null;

  const scoped = selectedKey ? facts.filter((item) => item.key === selectedKey) : facts;
  const monthlyMap = new Map<string, number>(months.map((month) => [month, 0]));
  for (const item of scoped) monthlyMap.set(item.month, (monthlyMap.get(item.month) ?? 0) + item.qty);
  const monthlyBase = months.map((month) => ({ date: month, value: round(monthlyMap.get(month) ?? 0, 4) }));
  const spc = detectSignals(monthlyBase, { minSamples: SPC_MIN_MONTHS });
  const monthly = monthlyBase.map((item) => ({
    month: item.date,
    qty: item.value,
    upper3: spc.bands?.upper3 ?? null,
    lower3: spc.bands?.lower3 ?? null,
  }));

  const current = latestMonth ? monthlyMap.get(latestMonth) ?? 0 : null;
  const previousMonth = months.length > 1 ? months.at(-2) ?? null : null;
  const previous = previousMonth ? monthlyMap.get(previousMonth) ?? 0 : null;
  const yearAgoMonth = latestMonth ? previousYearMonth(latestMonth) : null;
  const yearAgo = yearAgoMonth && months.includes(yearAgoMonth) ? monthlyMap.get(yearAgoMonth) ?? 0 : null;

  const latestRows = latestMonth
    ? facts
        .filter((item) => item.month === latestMonth)
        .sort((a, b) => b.qty - a.qty || a.label.localeCompare(b.label, "zh-CN"))
    : [];
  const latestTotal = latestRows.reduce((sum, item) => sum + item.qty, 0);
  let cumulative = 0;
  const pareto = latestRows.map((item) => {
    cumulative += item.qty;
    return {
      key: item.key,
      label: item.label,
      qty: round(item.qty, 4),
      sharePct: latestTotal > 0 ? round((item.qty / latestTotal) * 100, 1) : 0,
      cumulativePct: latestTotal > 0 ? round((cumulative / latestTotal) * 100, 1) : 0,
    };
  });
  const pareto80Count = latestTotal > 0 && pareto.length > 0
    ? pareto.findIndex((item) => item.cumulativePct >= 80) + 1 || pareto.length
    : null;
  const medianQty = median(latestRows.map((item) => item.qty));

  const topKeys = new Set(groups.slice(0, PIVOT_GROUP_LIMIT).map((item) => item.key));
  const pivotMap = new Map<string, { label: string; total: number; byMonth: Record<string, number> }>();
  for (const item of facts) {
    if (!topKeys.has(item.key)) continue;
    const row = pivotMap.get(item.key) ?? {
      label: item.label,
      total: 0,
      byMonth: Object.fromEntries(months.map((month) => [month, 0])),
    };
    row.total += item.qty;
    row.byMonth[item.month] = round((row.byMonth[item.month] ?? 0) + item.qty, 4);
    pivotMap.set(item.key, row);
  }
  const pivot = [...pivotMap.entries()]
    .map(([key, value]) => ({ key, ...value, total: round(value.total, 4) }))
    .sort((a, b) => b.total - a.total);

  const dailyScopeSupported = !selectedKey || dimension === "sku";
  const relevantDaily = rawDaily.filter((item) => !selectedKey || item.skuCode === selectedKey);
  const latestJobByDate = new Map<string, number>();
  for (const item of relevantDaily) {
    latestJobByDate.set(item.bizDate, Math.max(latestJobByDate.get(item.bizDate) ?? 0, item.importJobId));
  }
  const latestDaily = relevantDaily.filter(
    (item) => latestJobByDate.get(item.bizDate) === item.importJobId,
  );
  const dailyMap = new Map<string, number>();
  for (const item of latestDaily) {
    dailyMap.set(item.bizDate, (dailyMap.get(item.bizDate) ?? 0) + item.qty);
  }
  const dailyDates = [...dailyMap.entries()]
    .map(([date, qty]) => ({ date, qty: round(qty, 4) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const coveredRows = latestDaily.filter((item) => item.status !== "pending" && item.skuId != null).length;
  const dailyGate = !dailyScopeSupported
    ? "JST 日事实没有渠道维度；选择品牌/渠道成员后不能诚实归因。清除成员筛选，或改按 SKU 分析。"
    : dailyDates.length === 0
      ? "尚未导入可用的 JST 日销量。请按模板接入日期、商家编码、仓库和数量。"
      : null;

  const momPct = pct(current, previous);
  const yoyPct = pct(current, yearAgo);
  const scopeName = selectedLabel ?? "全部";
  const top = pareto[0];
  const headline = latestMonth
    ? `${latestMonth} ${scopeName}销量 ${round(current ?? 0, 1).toLocaleString("zh-CN")}`
    : "暂无月销量事实";
  const bullets = [
    momPct == null
      ? "环比：缺少可比较的上一期或上一期为零，暂不计算。"
      : `环比：${momPct >= 0 ? "增长" : "下降"} ${Math.abs(momPct).toFixed(1)}%。`,
    top && pareto80Count !== null
      ? `${pareto80Count} 个${DIMENSION_LABELS[dimension]}贡献最新月约 80% 销量；第一位 ${top.label} 占 ${top.sharePct.toFixed(1)}%。`
      : top
        ? "结构：最新月销量合计不为正数，缺少可用的正数分母，不计算 80% 贡献成员数。"
        : "结构：当前期间没有可排名事实，缺少可用的正数分母，不计算 80% 贡献成员数。",
    yoyPct == null
      ? `同比：缺少 ${yearAgoMonth ?? "去年同期"} 一致口径数据，保持留白。`
      : `同比：${yoyPct >= 0 ? "增长" : "下降"} ${Math.abs(yoyPct).toFixed(1)}%。`,
    `统计异常：${spc.note}`,
  ];
  const markdown = [
    `# 月度经营回顾 · ${latestMonth ?? "无数据"}`,
    "",
    `范围：${dimension} / ${scopeName}`,
    `生成时间：${new Date().toISOString()}`,
    "",
    ...bullets.map((item) => `- ${item}`),
    "",
    "> 口径：sales_monthly 月销量数量；跨 SKU 汇总仅用于结构与趋势，不代表收入或利润。",
  ].join("\n");

  return {
    generatedAt: new Date().toISOString(),
    loadedSections: ["core", "daily", "external", "identity", "readiness"],
    channelScope: { forced: false, channelIds: null, label: null },
    dimension,
    selectedKey,
    selectedLabel,
    months,
    latestMonth,
    groups,
    monthly,
    comparison: {
      current,
      previous,
      momPct,
      yearAgo,
      yoyPct,
      yoyGate: yoyPct == null && latestMonth
        ? `缺少 ${yearAgoMonth} 一致口径月销量，不能计算同比。`
        : null,
    },
    pareto,
    pareto80Count,
    medianQty,
    pivot,
    spc,
    daily: {
      state: dailyGate ? "insufficient" : "ready",
      gate: dailyGate,
      dates: dailyScopeSupported ? dailyDates : [],
      coveredRows,
      totalRows: latestDaily.length,
      latestDate: dailyDates.at(-1)?.date ?? null,
    },
    externalDemand,
    commerceIdentity,
    dataSources,
    dataProductReleases: [],
    dataProductOutcomes: [],
    supportingObservations: [],
    review: { headline, bullets, markdown },
    limitations: [
      "sales_monthly 目前是月粒度数量事实；跨 SKU 相加可能混合件、箱、kg，仅作结构和趋势。",
      "没有净售价、平台费用、退款和完整成本时，不计算收入、毛利、GMROI 或现金转换。",
      "统计控制带至少需要 12 个一致月份；同比需要真实去年同期，缺失时必须留白。",
      "JST 日事实当前没有渠道、促销和可售状态，不能归因促销提升或断货损失。",
    ],
  };
}

/**
 * 跨维筛选一律用 EXISTS 子查询，**不动各分支原有的 join 结构**。
 * 直接加 join 会改变行的纳入口径——例如 sku 维加 innerJoin channels 会把无渠道的行
 * 整批丢掉，于是"没加筛选时"的既有数字也会跟着变。EXISTS 只过滤，不影响基数。
 * 无筛选时 where 传 undefined（drizzle 视作不加条件），保证与改动前逐字等价。
 */
function scopeWhere(scope: StudioScope, channelScope: ResolvedChannelScope = UNRESTRICTED_SCOPE) {
  const conds = [];
  // D62：受限用户强制加 channel_id 条件；不限用户不加（保持逐字等价）
  const forced = channelScopeCondition(schema.salesMonthly.channelId, channelScope);
  if (forced) conds.push(forced);
  if (scope.brand) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM skus ss LEFT JOIN brands bb ON bb.id = ss.brand_id
      WHERE ss.id = ${schema.salesMonthly.skuId}
        AND coalesce(bb.code, ${NO_BRAND}) = ${scope.brand}
    )`);
  }
  if (scope.channel) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM channels cc
      WHERE cc.id = ${schema.salesMonthly.channelId} AND cc.code = ${scope.channel}
    )`);
  }
  return conds.length ? and(...conds) : undefined;
}

async function loadMonthlyFacts(
  db: AnyDb,
  dimension: StudioDimension,
  scope: StudioScope = {},
  channelScope: ResolvedChannelScope = UNRESTRICTED_SCOPE,
): Promise<MonthlyGroupFact[]> {
  const qtyExpr = sql<string>`sum(${schema.salesMonthly.qty})`;
  const where = scopeWhere(scope, channelScope);

  if (dimension === "month") {
    // 月份维：只按月分组，配合 scope 就是「NING × 天猫 的月度走势」
    const rows: { month: string; key: string; label: string; qty: string }[] = await db
      .select({
        month: schema.salesMonthly.yearMonth,
        key: schema.salesMonthly.yearMonth,
        label: schema.salesMonthly.yearMonth,
        qty: qtyExpr,
      })
      .from(schema.salesMonthly)
      .where(where)
      .groupBy(schema.salesMonthly.yearMonth);
    return rows.map((item) => ({ ...item, qty: num(item.qty) }));
  }
  if (dimension === "channel") {
    const rows: { month: string; key: string; label: string; qty: string }[] = await db
      .select({
        month: schema.salesMonthly.yearMonth,
        key: schema.channels.code,
        label: schema.channels.name,
        qty: qtyExpr,
      })
      .from(schema.salesMonthly)
      .innerJoin(schema.channels, sql`${schema.salesMonthly.channelId} = ${schema.channels.id}`)
      .where(where)
      .groupBy(schema.salesMonthly.yearMonth, schema.channels.code, schema.channels.name);
    return rows.map((item) => ({ ...item, qty: num(item.qty) }));
  }
  if (dimension === "sku") {
    const rows: { month: string; key: string; label: string; qty: string }[] = await db
      .select({
        month: schema.salesMonthly.yearMonth,
        key: schema.skus.code,
        label: schema.skus.name,
        qty: qtyExpr,
      })
      .from(schema.salesMonthly)
      .innerJoin(schema.skus, sql`${schema.salesMonthly.skuId} = ${schema.skus.id}`)
      .where(where)
      .groupBy(schema.salesMonthly.yearMonth, schema.skus.code, schema.skus.name);
    return rows.map((item) => ({ ...item, qty: num(item.qty) }));
  }
  const keyExpr = sql<string>`coalesce(${schema.brands.code}, ${NO_BRAND})`;
  const labelExpr = sql<string>`coalesce(${schema.brands.nameCn}, '未分配品牌')`;
  const rows: { month: string; key: string; label: string; qty: string }[] = await db
    .select({
      month: schema.salesMonthly.yearMonth,
      key: keyExpr,
      label: labelExpr,
      qty: qtyExpr,
    })
    .from(schema.salesMonthly)
    .innerJoin(schema.skus, sql`${schema.salesMonthly.skuId} = ${schema.skus.id}`)
    .leftJoin(schema.brands, sql`${schema.skus.brandId} = ${schema.brands.id}`)
    .where(where)
    .groupBy(schema.salesMonthly.yearMonth, schema.brands.code, schema.brands.nameCn);
  return rows.map((item) => ({ ...item, qty: num(item.qty) }));
}

async function loadDailyFacts(db: AnyDb): Promise<DailyFact[]> {
  // staging_rows 已超过百万行，且既有索引是 (import_job_id, status)，不是 target_table。
  // 先从很小的 import_jobs 找到合法模板批次，再按 import_job_id 走索引；若尚无 JST
  // 批次则立即返回。禁止直接按 target_table 扫 staging_rows 的 JSON 大表。
  const jobs: { id: number }[] = await db
    .select({ id: schema.importJobs.id })
    .from(schema.importJobs)
    .where(sql`${schema.importJobs.template} = 'jst_daily_sales'`);
  const jobIds = jobs.map((item) => item.id);
  if (jobIds.length === 0) return [];

  const rows: {
    importJobId: number;
    status: "pending" | "validated" | "committed";
    payload: unknown;
  }[] = await db
    .select({
      importJobId: schema.stagingRows.importJobId,
      status: schema.stagingRows.status,
      payload: schema.stagingRows.payload,
    })
    .from(schema.stagingRows)
    .where(
      and(
        inArray(schema.stagingRows.importJobId, jobIds),
        sql`${schema.stagingRows.targetTable} = 'jst_daily_sales'`,
        sql`${schema.stagingRows.status} in ('pending', 'validated', 'committed')`,
      ),
    );
  const facts: DailyFact[] = [];
  for (const row of rows) {
    const payload = row.payload as {
      bizDate?: unknown;
      skuCode?: unknown;
      qty?: unknown;
      _resolved?: { skuId?: unknown };
    };
    if (
      typeof payload?.bizDate !== "string"
      || typeof payload?.skuCode !== "string"
      || !Number.isFinite(Number(payload?.qty))
    ) continue;
    facts.push({
      importJobId: row.importJobId,
      status: row.status,
      bizDate: payload.bizDate,
      skuCode: payload.skuCode,
      qty: Number(payload.qty),
      skuId: Number.isInteger(Number(payload._resolved?.skuId))
        ? Number(payload._resolved?.skuId)
        : null,
    });
  }
  return facts;
}

export async function getDecisionStudio(
  query: StudioQuery = {},
  dbArg?: AnyDb,
  user?: SessionUser,
): Promise<DecisionStudioResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const dimension = DIMENSIONS.includes(query.dimension as StudioDimension)
    ? (query.dimension as StudioDimension)
    : "brand";
  const scope = query.scope ?? {};
  const allSections: StudioSection[] = ["core", "daily", "external", "identity", "readiness"];
  const requestedSections = query.sections?.length
    ? [...new Set<StudioSection>(["core", ...query.sections])].filter((section) => allSections.includes(section))
    : allSections;
  const includes = (section: StudioSection) => requestedSections.includes(section);
  // D62：先解析渠道范围（越权 403），再取数；受限用户的月度事实强制按范围裁剪
  const channelScope = await resolveChannelScopeByCode(db, user, scope.channel);
  const [facts, daily, externalDemand, commerceIdentity, dataSources, supportingObservations] = await Promise.all([
    loadMonthlyFacts(db, dimension, scope, channelScope),
    // JST 日事实没有渠道维度：受限用户不能诚实裁剪，直接不取（下方 gate 说明）
    includes("daily") && !channelScope.forced ? loadDailyFacts(db) : Promise.resolve([]),
    // D62：外部平台观察是店铺级行（含他人渠道），受限用户一律不下发，给出空态与原因
    includes("external") && !channelScope.forced
      ? loadJiandaoyunExternalDemandSignal(db)
      : Promise.resolve(emptyExternalDemandSignal(channelScope.forced ? "受限渠道范围不下发外部平台观察（D62）。" : "切换到外部需求信号后加载。")),
    includes("identity") && !channelScope.forced
      ? loadCommerceIdentityCoverage(db)
      : Promise.resolve(emptyCommerceIdentityCoverage()),
    includes("readiness") ? loadDataSourceReadiness(db) : Promise.resolve([]),
    includes("readiness") && !channelScope.forced ? loadJiandaoyunSupportingObservations(db) : Promise.resolve([]),
  ]);
  const studio = buildDecisionStudio(
    facts,
    daily,
    { ...query, dimension },
    externalDemand,
    commerceIdentity,
    dataSources,
  );
  const dataProductReleases = includes("readiness")
    ? await loadDataProductReleaseReadiness(dataSources, user, db)
    : [];
  const dailyOut: DecisionStudioResult["daily"] = channelScope.forced
    ? {
        state: "insufficient",
        gate: `当前账号按渠道范围（${channelScope.scopeLabel ?? "本渠道"}）受限，JST 日事实没有渠道维度，不能诚实归因到本渠道，故不呈现。`,
        dates: [],
        coveredRows: 0,
        totalRows: 0,
        latestDate: null,
      }
    : studio.daily;
  return {
    ...studio,
    daily: dailyOut,
    channelScope: { forced: channelScope.forced, channelIds: channelScope.channelIds, label: channelScope.scopeLabel },
    loadedSections: requestedSections,
    supportingObservations,
    dataProductReleases,
    dataProductOutcomes: includes("readiness")
      ? await loadDataProductOutcomeReadiness(dataProductReleases, user, db)
      : [],
  };
}
