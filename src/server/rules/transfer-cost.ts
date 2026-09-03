/**
 * D60 调拨成本/数量/零散规则（纯函数，唯一权威）。
 *
 * - unitFee：单据单位费用 = 费用合计 ÷ 件数（qty ≤ 0 → null）。
 * - laneBaseline：同线路 (from,to,type) 近 windowDays 天已完成单据的**数量加权均价** Σfee/Σqty，
 *   并给出单位费用中位数与样本数（研究护栏：n 随数值一起输出）。
 * - deviation 两档：
 *   · samples < minSamples（默认 8）：|pctDev| > thresholdPct → watch 并标"样本不足"，**永不 alert**；
 *   · samples ≥ minSamples：rules/spc.ts 中位数+MAD：|z| > 3 → alert；2 < |z| ≤ 3 → watch；σ=0 不出统计信号；
 *     统计带内但 |pctDev| > thresholdPct 仍给 watch（D60 "偏差超 20% 提醒不阻断"）。
 * - qtyAnomaly：本单件数 > 中位数 × multiplier（默认 3）→ watch；samples < 8 → 'insufficient'（明示不判定）。
 * - scatteredLane：30 天同线路单据数 > maxDocs（默认 4）→ 零散。
 * 金额 scale 2、数量 scale 4、单位费用 scale 4；全部 decimal 字符串。
 */
import { type Dec, dAdd, dCmp, dDeviationPct, dDiv, dMul, dQty } from "@/server/core/decimal";
import { computeBands } from "@/server/rules/spc";

export interface FeeQty {
  feeTotal: Dec;
  qty: Dec;
}

/** 单位费用（scale 4）；qty ≤ 0 → null */
export function unitFee(input: FeeQty): string | null {
  if (dCmp(input.qty, 0) <= 0) return null;
  return dDiv(input.feeTotal, input.qty, 4);
}

export interface LaneHistoryRow extends FeeQty {
  /** 完成日 YYYY-MM-DD（或 ISO 串） */
  date: string;
}

export interface LaneBaseline {
  /** 数量加权均价 Σfee/Σqty（scale 4）；无样本 → null */
  avgUnitFee: string | null;
  /** 单位费用中位数（scale 4）；无样本 → null */
  median: string | null;
  samples: number;
  /** 窗口内逐单单位费用（升序，供 SPC） */
  unitFees: string[];
  windowStart: string;
  windowEnd: string;
}

function shiftDay(ymd: string, delta: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

function medianOf(sortedAsc: string[]): string | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 ? sortedAsc[mid] : dDiv(dAdd(sortedAsc[mid - 1], sortedAsc[mid], 6), 2, 4);
}

/** 窗口 (asOf − windowDays, asOf]；qty ≤ 0 或 fee < 0 的行不计 */
export function laneBaseline(history: LaneHistoryRow[], windowDays: number, asOf: string): LaneBaseline {
  const end = asOf.slice(0, 10);
  const start = shiftDay(end, -Math.max(0, Math.trunc(windowDays)) + 1);
  let sumFee = "0.00";
  let sumQty = "0.0000";
  const fees: string[] = [];
  for (const h of history ?? []) {
    const d = (h.date ?? "").slice(0, 10);
    if (d < start || d > end) continue;
    if (dCmp(h.qty, 0) <= 0 || dCmp(h.feeTotal, 0) < 0) continue;
    sumFee = dAdd(sumFee, h.feeTotal, 2);
    sumQty = dAdd(sumQty, h.qty, 4);
    fees.push(dDiv(h.feeTotal, h.qty, 4));
  }
  fees.sort(dCmp);
  return {
    avgUnitFee: fees.length ? dDiv(sumFee, sumQty, 4) : null,
    median: medianOf(fees),
    samples: fees.length,
    unitFees: fees,
    windowStart: start,
    windowEnd: end,
  };
}

export type DeviationLevel = "ok" | "watch" | "alert";

export interface DeviationOptions {
  thresholdPct: number;
  minSamples?: number;
}

export interface DeviationResult {
  level: DeviationLevel;
  /** 相对数量加权均价的偏差 %（scale 2）；无基线 → null */
  pctDev: string | null;
  /** SPC z 分数（samples ≥ minSamples 且 σ>0 时） */
  z: number | null;
  samples: number;
  insufficient: boolean;
  reason: string;
}

export function deviation(currentUnitFee: Dec | null, baseline: LaneBaseline, opts: DeviationOptions): DeviationResult {
  const minSamples = opts.minSamples ?? 8;
  const samples = baseline.samples;
  if (currentUnitFee == null) {
    return { level: "ok", pctDev: null, z: null, samples, insufficient: samples < minSamples, reason: "本单无单位费用（件数为 0 或未登记费用）" };
  }
  if (!baseline.avgUnitFee || samples === 0 || dCmp(baseline.avgUnitFee, 0) <= 0) {
    return { level: "ok", pctDev: null, z: null, samples, insufficient: true, reason: "同线路无历史基线，暂不判定" };
  }
  const pctDev = dDeviationPct(baseline.avgUnitFee, currentUnitFee);
  const absPct = pctDev.startsWith("-") ? pctDev.slice(1) : pctDev;
  const overThreshold = dCmp(absPct, opts.thresholdPct) > 0;

  if (samples < minSamples) {
    return overThreshold
      ? { level: "watch", pctDev, z: null, samples, insufficient: true, reason: `样本不足（${samples}/${minSamples}），偏离基线 ${pctDev}% 超过 ${opts.thresholdPct}%，仅提醒` }
      : { level: "ok", pctDev, z: null, samples, insufficient: true, reason: `样本不足（${samples}/${minSamples}），偏差 ${pctDev}% 在阈值内` };
  }

  const bands = computeBands(baseline.unitFees.map(Number), { robust: true });
  if (!bands || !(bands.sigma > 0)) {
    return overThreshold
      ? { level: "watch", pctDev, z: null, samples, insufficient: false, reason: `历史单价无波动（σ=0），不做统计判定；偏离基线 ${pctDev}% 超过 ${opts.thresholdPct}%，仅提醒` }
      : { level: "ok", pctDev, z: null, samples, insufficient: false, reason: "历史单价无波动（σ=0），偏差在阈值内" };
  }
  const z = Math.round(((Number(currentUnitFee) - bands.center) / bands.sigma) * 100) / 100;
  const absZ = Math.abs(z);
  if (absZ > 3) {
    return { level: "alert", pctDev, z, samples, insufficient: false, reason: `单位费用偏离中位数 ${absZ.toFixed(1)}σ（>3σ），偏差 ${pctDev}%` };
  }
  if (absZ > 2) {
    return { level: "watch", pctDev, z, samples, insufficient: false, reason: `单位费用偏离中位数 ${absZ.toFixed(1)}σ（2–3σ），偏差 ${pctDev}%` };
  }
  return overThreshold
    ? { level: "watch", pctDev, z, samples, insufficient: false, reason: `统计带内（${absZ.toFixed(1)}σ）但偏离基线 ${pctDev}% 超过 ${opts.thresholdPct}%，仅提醒` }
    : { level: "ok", pctDev, z, samples, insufficient: false, reason: `统计带内（${absZ.toFixed(1)}σ），偏差 ${pctDev}%` };
}

export type QtyAnomalyLevel = "ok" | "watch" | "insufficient";

export interface QtyAnomalyResult {
  level: QtyAnomalyLevel;
  /** 历史件数中位数（scale 4）；样本不足仍给出（可为 null） */
  median: string | null;
  /** 本单 ÷ 中位数（scale 2）；中位数 0 → null */
  ratio: string | null;
  samples: number;
  reason: string;
}

const QTY_MIN_SAMPLES = 8;

export function qtyAnomaly(qty: Dec, history: { qty: Dec }[], multiplier = 3): QtyAnomalyResult {
  const qtys = (history ?? []).filter((h) => dCmp(h.qty, 0) > 0).map((h) => dQty(h.qty)).sort(dCmp);
  const samples = qtys.length;
  const median = medianOf(qtys);
  const ratio = median && dCmp(median, 0) > 0 ? dDiv(qty, median, 2) : null;
  if (samples < QTY_MIN_SAMPLES) {
    return { level: "insufficient", median, ratio, samples, reason: `样本不足（${samples}/${QTY_MIN_SAMPLES}），暂不判定` };
  }
  if (median && dCmp(qty, dMul(median, multiplier, 4)) > 0) {
    return { level: "watch", median, ratio, samples, reason: `本单 ${dQty(qty)} 件 > 中位数 ${median} × ${multiplier}` };
  }
  return { level: "ok", median, ratio, samples, reason: "件数在中位数倍数范围内" };
}

export interface ScatteredLaneResult {
  scattered: boolean;
  docs: number;
  maxDocs: number;
}

/** 30 天同线路单据数 > maxDocs → 零散调拨 */
export function scatteredLane(docsInWindow: number | unknown[], maxDocs = 4): ScatteredLaneResult {
  const docs = Array.isArray(docsInWindow) ? docsInWindow.length : Math.max(0, Math.trunc(docsInWindow));
  return { scattered: docs > maxDocs, docs, maxDocs };
}
