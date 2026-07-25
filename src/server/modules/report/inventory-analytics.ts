/**
 * E7-04 库存分析三视图（只读报表层）：健康散点 × 库存账龄 × 周转指标。
 *
 * 缺口背景：既有页面只答「多少件」「还能卖多久」，答不了「已经压了多久」和「一年转几次」——
 * 效期健康但压了半年的库存同样是资金坟场，管理层问周转时系统只会报件数。
 *
 * 五源既有数据，不新增口径、不写库：
 * - 在库：Σ stock_balances + 快照仓最新快照（全网口径 D20，与 report/risk.ts 同法）；
 * - 销速：sales_monthly 近3月 ÷ 91（core/velocity.ts 唯一口径，禁本地重实现）；
 * - 出库：stock_ledger 窗口内 qtyDelta<0 取 Σ(-qtyDelta)（本表只有带符号 qtyDelta，无单独出入库列）；
 * - 账龄：stock_ledger 窗口外全历史 qtyDelta>0 按上海时区日聚合 → rules/fifoAging 回溯；
 * - 分层：report/segmentation.ts 的 ABC/XYZ cell（散点着色用，allRows 取全量防截断）。
 *
 * ⚠ 已知简化（务必与 UI 提示一致，不得私自"看起来更准"）：
 * **平均在库用当前在库近似**——本系统无历史每日库存快照表（stock_snapshots 仅覆盖快照仓，
 * 且非全 SKU 每日连续），无法还原窗口内的日均库存。故 turns/dio 在库存水位剧烈变动的
 * SKU 上会失真（补货前后差异大时尤甚），只可用于横向排序与量级判断，不可用于财务对账。
 * 修正路径：待接入每日库存快照/期初期末余额后，把 avgOnHand 换成 (期初+期末)/2 或日均。
 *
 * 全表无金额字段，免脱敏；只读不写库。
 */
import { and, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { coverDays } from "@/server/core/stock-view";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";
import { getNumParam } from "@/server/core/params";
import { DAILY_WINDOW_DAYS, dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { getSegmentation } from "@/server/modules/report/segmentation";
import { AGING_BUCKETS, fifoAging, turnover, type AgingBucket } from "@/server/rules/inventory-metrics";
import { num, r1, r1n } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** 窗口天数上下限（1 天无统计意义，>730 天与"近期周转"语义脱节） */
const WINDOW_MIN = 7;
const WINDOW_MAX = 730;
const WINDOW_DEFAULT = 90;

export interface InvAnalyticsRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  /** 全网在库 = 实时账 + 快照仓最新快照 */
  onHand: number;
  /** 近3月日均销（÷91） */
  daily: number;
  /** 可销天数（无动销 = null） */
  daysCover: number | null;
  /** 窗口内出库量 Σ(-qtyDelta) where qtyDelta<0 */
  outQty: number;
  /** 平均在库（⚠ 当前在库近似，见文件头） */
  avgOnHand: number;
  /** 年化周转次数（无法计算 = null） */
  turns: number | null;
  /** 库存周转天数 DIO（无法计算 = null） */
  dio: number | null;
  /** 账龄五桶数量 */
  aging: Record<AgingBucket, number>;
  /** 加权平均库龄（天）；无可归属入库来源 = null */
  avgAgeDays: number | null;
  /** 来源不明数量（在库 > 历史入库合计的差额） */
  unknownOriginQty: number;
  /** ABC/XYZ 格（无分层结果 = null） */
  cell: string | null;
  abc: "A" | "B" | "C" | null;
}

export interface InvAnalyticsResult {
  rows: InvAnalyticsRow[];
  total: number;
  summary: {
    skuCount: number;
    agingTotals: Record<AgingBucket, number>;
    /** 有效 SKU 的周转次数算术平均（非跨 SKU 量纲相加，避免混装失真） */
    avgTurns: number | null;
    /** 由 avgTurns 反算 365/avgTurns（不对倒数取平均，防长尾 SKU 把均值拉爆） */
    avgDio: number | null;
    unknownOriginQty: number;
    windowDays: number;
  };
  today: string;
  /** 可销天数告警阈值（运行参数 cover_alert_days，散点参考线用） */
  coverAlertDays: number;
  /** 滞销阈值（运行参数 slow_days_threshold，散点参考线用） */
  slowDaysThreshold: number;
  /** 平均在库近似的口径声明（UI 必须原样呈现，不得省略） */
  avgOnHandNote: string;
}

export const AVG_ONHAND_NOTE =
  "周转指标的「平均在库」用当前在库近似——系统无历史每日库存快照，无法还原窗口内日均库存。补货前后水位波动大的 SKU 会失真，仅供横向排序与量级判断，不可用于财务对账。";

export async function getInventoryAnalytics(
  query: { q?: string; windowDays?: number; page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<InvAnalyticsResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = todayShanghai();
  const windowDays = Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, Math.floor(query.windowDays ?? WINDOW_DEFAULT)));
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();

  const emptyAging = (): Record<AgingBucket, number> =>
    Object.fromEntries(AGING_BUCKETS.map((k) => [k, 0])) as Record<AgingBucket, number>;

  const [coverAlertDays, slowDaysThreshold] = await Promise.all([
    getNumParam("cover_alert_days", 30, dbArg),
    getNumParam("slow_days_threshold", 180, dbArg),
  ]);

  const emptyResult = (): InvAnalyticsResult => ({
    rows: [],
    total: 0,
    summary: { skuCount: 0, agingTotals: emptyAging(), avgTurns: null, avgDio: null, unknownOriginQty: 0, windowDays },
    today,
    coverAlertDays,
    slowDaysThreshold,
    avgOnHandNote: AVG_ONHAND_NOTE,
  });

  /* ── 成品主档（finished + active，与 ABC/XYZ 分层同范围） ── */
  const skuRows: { id: number; code: string; name: string; brand: string | null }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, brand: schema.brands.nameCn })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(sql`${schema.skus.active} = true and ${schema.skus.skuType} = 'finished'`);
  if (skuRows.length === 0) return emptyResult();
  const skuIds = skuRows.map((s) => s.id);

  /* ── 在库：实时账 + 快照仓最新快照（口径同 report/risk.ts） ── */
  const balRows: { skuId: number; qty: string | null }[] = await db
    .select({ skuId: schema.stockBalances.skuId, qty: sql<string | null>`sum(${schema.stockBalances.qty})` })
    .from(schema.stockBalances)
    .groupBy(schema.stockBalances.skuId);
  const onHandBySku = new Map<number, number>(balRows.map((r) => [r.skuId, num(r.qty)]));
  const s = schema.stockSnapshots;
  const latest = db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, maxDate: sql<string>`max(${s.bizDate})`.as("max_date") })
    .from(s)
    .groupBy(s.warehouseId, s.skuId)
    .as("latest");
  const snapRows: { skuId: number; qty: string }[] = await db
    .select({ skuId: s.skuId, qty: s.qty })
    .from(s)
    .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)));
  for (const r of snapRows) onHandBySku.set(r.skuId, (onHandBySku.get(r.skuId) ?? 0) + num(r.qty));

  /* ── 销速：近3月窗口 ÷ 91（core/velocity 唯一口径） ── */
  const sm = schema.salesMonthly;
  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const salesRows: { skuId: number; qty: string | null }[] = months3.length
    ? await db
        .select({ skuId: sm.skuId, qty: sql<string | null>`sum(${sm.qty})` })
        .from(sm)
        .where(inArray(sm.yearMonth, months3))
        .groupBy(sm.skuId)
    : [];
  const dailyBySku = new Map<number, number>(salesRows.map((r) => [r.skuId, dailyFromWindow(num(r.qty))]));

  /* ── 窗口出库：stock_ledger qtyDelta<0 → Σ(-qtyDelta)（本表无出入库标志列） ── */
  const sl = schema.stockLedger;
  // 窗口起点 = 口径日（上海）零点回推 windowDays 天
  const windowStart = new Date(Date.parse(`${today}T00:00:00+08:00`) - windowDays * 86_400_000);
  const outRows: { skuId: number; qty: string | null }[] = await db
    .select({ skuId: sl.skuId, qty: sql<string | null>`sum(-${sl.qtyDelta})` })
    .from(sl)
    .where(and(inArray(sl.skuId, skuIds), lt(sl.qtyDelta, "0"), gte(sl.occurredAt, windowStart)))
    .groupBy(sl.skuId);
  const outBySku = new Map<number, number>(outRows.map((r) => [r.skuId, num(r.qty)]));

  /* ── 账龄用入库：全历史 qtyDelta>0，按 SKU×上海时区日 聚合（DB 侧聚合，避免拉全量流水行） ── */
  const inbRows: { skuId: number; day: string; qty: string | null }[] = await db
    .select({
      skuId: sl.skuId,
      day: sql<string>`to_char(${sl.occurredAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`,
      qty: sql<string | null>`sum(${sl.qtyDelta})`,
    })
    .from(sl)
    .where(and(inArray(sl.skuId, skuIds), gt(sl.qtyDelta, "0")))
    .groupBy(sl.skuId, sql`to_char(${sl.occurredAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`);
  const inboundsBySku = new Map<number, { date: string; qty: number }[]>();
  for (const r of inbRows) {
    const arr = inboundsBySku.get(r.skuId);
    const item = { date: r.day, qty: num(r.qty) };
    if (arr) arr.push(item);
    else inboundsBySku.set(r.skuId, [item]);
  }

  /* ── ABC/XYZ 分层（allRows 取全量，防静默截断） ── */
  const seg = await getSegmentation({ allRows: true }, dbArg);
  const cellBySku = new Map<number, { cell: string; abc: "A" | "B" | "C" }>(
    seg.rows.map((r) => [r.skuId, { cell: r.cell, abc: r.abc }]),
  );

  /* ── 逐 SKU 计算 ── */
  const all: InvAnalyticsRow[] = [];
  for (const sku of skuRows) {
    const onHand = onHandBySku.get(sku.id) ?? 0;
    const daily = dailyBySku.get(sku.id) ?? 0;
    const outQty = outBySku.get(sku.id) ?? 0;
    // ⚠ 简化：平均在库 = 当前在库（无历史日库存，见文件头）
    const avgOnHand = onHand;
    const t = turnover(outQty, avgOnHand, windowDays);
    const ag = fifoAging(inboundsBySku.get(sku.id) ?? [], onHand, today);
    const seg1 = cellBySku.get(sku.id);
    const aging = emptyAging();
    for (const b of ag.buckets) aging[b.key] = r2(b.qty);
    all.push({
      skuId: sku.id,
      code: sku.code,
      name: sku.name,
      brand: sku.brand,
      onHand: r2(onHand),
      daily: r2(daily),
      daysCover: r1n(coverDays(onHand, daily)),
      outQty: r2(outQty),
      avgOnHand: r2(avgOnHand),
      turns: t.turns == null ? null : r2(t.turns),
      dio: t.dio == null ? null : r1(t.dio),
      aging,
      avgAgeDays: ag.weightedAvgAgeDays == null ? null : r1(ag.weightedAvgAgeDays),
      unknownOriginQty: r2(ag.unknownOriginQty),
      cell: seg1?.cell ?? null,
      abc: seg1?.abc ?? null,
    });
  }

  /* ── 筛选（汇总口径 = 筛选后全集，与用户屏幕上的范围一致；分页不影响汇总） ── */
  const filtered = q ? all.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : all;

  const agingTotals = emptyAging();
  let unknownOriginQty = 0;
  let turnsSum = 0;
  let turnsCount = 0;
  for (const r of filtered) {
    for (const k of AGING_BUCKETS) agingTotals[k] += r.aging[k];
    unknownOriginQty += r.unknownOriginQty;
    if (r.turns != null) { turnsSum += r.turns; turnsCount += 1; }
  }
  for (const k of AGING_BUCKETS) agingTotals[k] = r2(agingTotals[k]);
  const avgTurns = turnsCount > 0 ? r2(turnsSum / turnsCount) : null;

  filtered.sort((a, b) => b.onHand - a.onHand);

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    summary: {
      skuCount: filtered.length,
      agingTotals,
      avgTurns,
      avgDio: avgTurns != null && avgTurns > 0 ? r1(365 / avgTurns) : null,
      unknownOriginQty: r2(unknownOriginQty),
      windowDays,
    },
    today,
    coverAlertDays,
    slowDaysThreshold,
    avgOnHandNote: AVG_ONHAND_NOTE,
  };
}

/** 日均销窗口天数（导出/UI 口径注脚复用，避免前端硬编码 91） */
export const DAILY_WINDOW = DAILY_WINDOW_DAYS;
