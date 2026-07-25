/**
 * E5-10 异动侦测（只读报表层）：把现有月度数据里「没人主动去问」的三类信号跑成清单。
 *
 * 判定全部委托 rules/detectors.ts 纯函数（可测），本模块只负责取数与阈值组合：
 * - 销量骤停：近 6 月 sales_monthly 序列（升序，缺月补 0）→ detectSalesStop（默认跌幅阈值 70%）；
 * - 渠道结构迁移：最近两月 sales_monthly × channels 分布 → detectChannelShift（默认 15 个百分点）；
 * - 速度突变：近 1 月日均（月销 ÷ 30.4）vs 近 3 月基线日均（窗口销量 ÷ 91）→ detectVelocityChange（默认 ±40%）。
 *
 * 口径来源（不新增口径）：
 * - 月窗回推 = core/velocity.lastMonths（由 sales_monthly 最新月回推，与驾驶舱/风险同法）；
 * - 日均折算 = core/velocity.monthlyToDaily / dailyFromWindow（两者除数不同，见下方 note 明示）；
 * - 在库 = core/stock-view.getOnHandBySku（全网 D20 口径：实时账 + 各快照仓最新快照）。
 *
 * 只输出命中的行——无异常不占位。命中 ≠ 结论：规则化提示，需人工确认。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dailyFromWindow, lastMonths, monthlyToDaily } from "@/server/core/velocity";
import { getOnHandBySku } from "@/server/core/stock-view";
import { detectChannelShift, detectSalesStop, detectVelocityChange } from "@/server/rules/detectors";
import { type AnyDb, resolveDb } from "@/server/modules/outsource/common";
import { num, r1 } from "@/server/core/svc";

export type DetectorKind = "sales_stop" | "channel_shift" | "velocity";
export type DetectorSeverity = "high" | "medium";

export const DETECTOR_KIND_LABELS: Record<DetectorKind, string> = {
  sales_stop: "销量骤停",
  channel_shift: "渠道迁移",
  velocity: "速度突变",
};

/** 侦测阈值（与 rules/detectors 默认值一致，集中在此便于日后参数化） */
export const DETECTOR_THRESHOLDS = {
  /** 销量骤停：较前期均值跌幅超过此值即命中（末期为 0 直接命中） */
  salesDrop: 0.7,
  /** 渠道迁移：任一渠道占比变化绝对值超过此百分点即命中 */
  channelShiftPct: 15,
  /** 速度突变：本期日均相对基线偏离超过此值即命中 */
  velocityDeviation: 0.4,
  /** 销量骤停最少样本期数（不足不判定） */
  minPeriods: 3,
} as const;

/** 单个侦测器在某 SKU 上的命中 */
export interface DetectorHit {
  kind: DetectorKind;
  severity: DetectorSeverity;
  title: string;
  detail: string;
}

/**
 * 一行 = 一个 SKU（**不是一次命中**）。
 *
 * 改成按对象合并之前，三个侦测器各自出行，同一个 SKU 会在页面上出现两三次：
 * 真实数据 554 行只覆盖 343 个 SKU，其中 46 个 SKU 三条全中。
 * 人看的是「这个 SKU 怎么了」，不是「销量骤停清单里有没有它」——
 * 一个对象一行、把命中原因列在一起，才是可处置的形态。
 */
export interface DetectorRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  /** 该 SKU 命中的全部侦测器（≥1 条，按严重度排序） */
  hits: DetectorHit[];
  /** hits 中的最高严重度 */
  severity: DetectorSeverity;
  /** 命中条数——同时中多条通常更值得先看 */
  hitCount: number;
  /** 全网在库（D20 口径） */
  onHand: number;
  /** 最近一期月销 */
  lastQty: number;
}

export interface DetectorSummary {
  salesStop: number;
  channelShift: number;
  velocity: number;
  /** 参与扫描的成品 SKU 数 */
  scanned: number;
  /** 命中的 SKU 数（= 行数）；与三项之和的差额即「同一 SKU 中多条」的重叠量 */
  affectedSkus: number;
  /** 同时命中 ≥2 条的 SKU 数 */
  multiHitSkus: number;
}

export interface DetectorResult {
  rows: DetectorRow[];
  total: number;
  summary: DetectorSummary;
  /** 参与判定的月窗（升序，末位=最近一期） */
  months: string[];
  /** 数据最新月（无销量数据 = null） */
  maxYm: string | null;
  /** 在库快照时点（无快照仓 = null） */
  snapDate: string | null;
  thresholds: typeof DETECTOR_THRESHOLDS;
}

const EMPTY_SUMMARY: DetectorSummary = { salesStop: 0, channelShift: 0, velocity: 0, scanned: 0, affectedSkus: 0, multiHitSkus: 0 };

export async function getDetectorAlerts(
  query: { q?: string; kind?: DetectorKind; page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<DetectorResult> {
  const db = await resolveDb(dbArg);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();

  /* ── 成品主档（只扫成品：包材/原料无渠道销量口径） ── */
  const skuRows: { id: number; code: string; name: string; brand: string | null }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, brand: schema.brands.nameCn })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(and(eq(schema.skus.active, true), eq(schema.skus.skuType, "finished")));

  const base: Omit<DetectorResult, "rows" | "total" | "summary"> = {
    months: [],
    maxYm: null,
    snapDate: null,
    thresholds: DETECTOR_THRESHOLDS,
  };
  if (skuRows.length === 0) return { ...base, rows: [], total: 0, summary: EMPTY_SUMMARY };
  const skuIds = skuRows.map((s) => s.id);

  /* ── 月窗：由数据最新月回推 6 期（core/velocity 唯一口径） ── */
  const sm = schema.salesMonthly;
  const [{ maxYm }]: { maxYm: string | null }[] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months = maxYm ? lastMonths(maxYm, 6) : [];
  if (months.length === 0) {
    return { ...base, rows: [], total: 0, summary: { ...EMPTY_SUMMARY, scanned: skuRows.length } };
  }
  const currYm = months[months.length - 1];
  const prevYm = months[months.length - 2];
  const months3 = months.slice(-3);

  /* ── 月度序列（SKU × 月，全渠道汇总） ── */
  const seriesRows: { skuId: number; ym: string; qty: string | null }[] = await db
    .select({ skuId: sm.skuId, ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
    .from(sm)
    .where(and(inArray(sm.yearMonth, months), inArray(sm.skuId, skuIds)))
    .groupBy(sm.skuId, sm.yearMonth);
  const seriesBySku = new Map<number, Map<string, number>>();
  for (const r of seriesRows) {
    let m = seriesBySku.get(r.skuId);
    if (!m) { m = new Map(); seriesBySku.set(r.skuId, m); }
    m.set(r.ym, num(r.qty));
  }

  /* ── 最近两月渠道分布（SKU × 月 × 渠道） ── */
  const chRows: { skuId: number; ym: string; channel: string; qty: string | null }[] = await db
    .select({ skuId: sm.skuId, ym: sm.yearMonth, channel: schema.channels.name, qty: sql<string | null>`sum(${sm.qty})` })
    .from(sm)
    .innerJoin(schema.channels, eq(sm.channelId, schema.channels.id))
    .where(and(inArray(sm.yearMonth, [prevYm, currYm]), inArray(sm.skuId, skuIds)))
    .groupBy(sm.skuId, sm.yearMonth, schema.channels.name);
  const chBySku = new Map<number, { prev: Map<string, number>; curr: Map<string, number> }>();
  for (const r of chRows) {
    let e = chBySku.get(r.skuId);
    if (!e) { e = { prev: new Map(), curr: new Map() }; chBySku.set(r.skuId, e); }
    const target = r.ym === currYm ? e.curr : e.prev;
    target.set(r.channel, (target.get(r.channel) ?? 0) + num(r.qty));
  }

  /* ── 在库：全网口径（core/stock-view 唯一实现） ── */
  const onHandView = await getOnHandBySku(db, { skuIds });

  /* ── 逐 SKU 判定（一个 SKU 一行，命中原因合并在行内） ── */
  const all: DetectorRow[] = [];
  const summary: DetectorSummary = {
    salesStop: 0, channelShift: 0, velocity: 0,
    scanned: skuRows.length, affectedSkus: 0, multiHitSkus: 0,
  };
  for (const sku of skuRows) {
    const hits: DetectorHit[] = [];
    const byYm = seriesBySku.get(sku.id) ?? new Map<string, number>();
    const series = months.map((ym) => byYm.get(ym) ?? 0);
    const lastQty = series[series.length - 1];
    const onHand = num(onHandView.bySku.get(sku.id));
    const meta = { skuId: sku.id, code: sku.code, name: sku.name, brand: sku.brand, onHand: r1(onHand), lastQty: r1(lastQty) };

    // ① 销量骤停（有库存的骤停最危险：货压着而出口没了 → high）
    const stop = detectSalesStop(series, DETECTOR_THRESHOLDS.salesDrop);
    if (stop.stopped) {
      summary.salesStop++;
      hits.push({
        kind: "sales_stop",
        severity: onHand > 0 ? "high" : "medium",
        title: `${currYm} 销量${stop.lastQty === 0 ? "归零" : "骤降"}`,
        detail: `${stop.reason}；在库 ${r1(onHand)}${onHand > 0 ? "（有货无出口，优先核查链接/库存可售状态）" : "（无在库，影响较小）"}`,
      });
    }

    // ② 渠道结构迁移（结构位移，与量级无关）
    const ch = chBySku.get(sku.id);
    if (ch) {
      const shift = detectChannelShift(ch.prev, ch.curr, DETECTOR_THRESHOLDS.channelShiftPct);
      if (shift.shifted) {
        summary.channelShift++;
        const top3 = shift.movements
          .slice(0, 3)
          .map((m) => `${m.channel} ${m.fromPct}%→${m.toPct}%（${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}pp）`)
          .join("；");
        hits.push({
          kind: "channel_shift",
          severity: "medium",
          title: `${prevYm}→${currYm} 渠道结构位移`,
          detail: `${shift.note}。位移明细：${top3}`,
        });
      }
    }

    // ③ 速度突变（近 1 月日均 vs 近 3 月基线日均）
    const recentDaily = monthlyToDaily(lastQty);
    const baselineDaily = dailyFromWindow(months3.reduce((a, ym) => a + (byYm.get(ym) ?? 0), 0));
    const vel = detectVelocityChange(recentDaily, baselineDaily, DETECTOR_THRESHOLDS.velocityDeviation);
    if (vel.changed) {
      summary.velocity++;
      hits.push({
        kind: "velocity",
        severity: "medium",
        title: `销速${vel.direction === "up" ? "提速" : "降速"} ${Math.abs(vel.deviationPct ?? 0)}%`,
        detail:
          `近 1 月日均 ${r1(recentDaily)}（月销 ÷ 30.4）vs 近 3 月基线日均 ${r1(baselineDaily)}（${months3[0]}~${months3[2]} 窗口销量 ÷ 91），` +
          `偏离 ${vel.deviationPct}%（阈值 ±${DETECTOR_THRESHOLDS.velocityDeviation * 100}%）。` +
          `这是「最近 1 个月」与「近 3 个月均值」之比，季节性与单月大促都会体现为偏离——先看是不是这两类，再判断是否异常`,
      });
    }

    if (hits.length === 0) continue; // 零命中不占位
    const SEV_RANK: Record<DetectorSeverity, number> = { high: 0, medium: 1 };
    const KIND_RANK: Record<DetectorKind, number> = { sales_stop: 0, channel_shift: 1, velocity: 2 };
    hits.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    summary.affectedSkus++;
    if (hits.length >= 2) summary.multiHitSkus++;
    all.push({ ...meta, hits, severity: hits[0].severity, hitCount: hits.length });
  }

  /* ── 筛选/排序/分页 ──
   * 排序：严重度 → 命中条数（同时中多条更值得先看）→ 在库量（货多的先看）。 */
  let filtered = all;
  if (query.kind) filtered = filtered.filter((r) => r.hits.some((h) => h.kind === query.kind));
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const SEV_ORDER: Record<DetectorSeverity, number> = { high: 0, medium: 1 };
  filtered = [...filtered].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.hitCount - a.hitCount || b.onHand - a.onHand,
  );

  return {
    ...base,
    months,
    maxYm,
    snapDate: onHandView.snapDate,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    summary,
  };
}
