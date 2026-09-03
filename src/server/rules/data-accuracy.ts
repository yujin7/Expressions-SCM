/**
 * D65 数据质量准确率（纯函数，唯一权威）。
 *
 * - dailyMatchRate：SKU 日级一致率——|expected − actual| ≤ tolerancePct% × max(|expected|, |actual|) 记一致
 *   （两侧皆 0 恒一致；容差 0 = 严格相等）；rate = matched/total × 100（2dp），total=0 → null。
 * - qtyWeightedMatchRate：按 |expected| 加权（expected 为 0 的行按 |actual| 计权）；总权重 0 → null。
 * - stagingPassRate：staging 放行率 = ok/(ok+rejected) × 100；总数 0 → null。
 * 三类来源（rpa_warehouse / manual_po_chain / external_platform）由调用方分组后各调一次。
 * 数量 decimal 字符串（禁 float）；输出 rate 为 number 供图卡。
 */
import { type Dec, dAdd, dCmp, dDiv, dMul, dSub } from "@/server/core/decimal";

export interface AccuracyRow {
  expected: Dec;
  actual: Dec;
}

export interface MatchRate {
  matched: number;
  total: number;
  /** 百分比 2dp；total=0 → null */
  rate: number | null;
}

function absDec(v: string): string {
  return v.startsWith("-") ? v.slice(1) : v;
}

function isMatch(row: AccuracyRow, tolerancePct: number): boolean {
  const diff = absDec(dSub(row.expected, row.actual, 6));
  const base = dCmp(absDec(dSub(row.expected, 0, 6)), absDec(dSub(row.actual, 0, 6))) >= 0
    ? absDec(dSub(row.expected, 0, 6))
    : absDec(dSub(row.actual, 0, 6));
  const allowed = dMul(base, dDiv(Math.max(0, tolerancePct), 100, 6), 6);
  return dCmp(diff, allowed) <= 0;
}

function pct(numerator: Dec, denominator: Dec): number | null {
  if (dCmp(denominator, 0) <= 0) return null;
  return Number(dMul(dDiv(numerator, denominator, 6), 100, 2));
}

export function dailyMatchRate(rows: AccuracyRow[], tolerancePct: number): MatchRate {
  const total = rows?.length ?? 0;
  const matched = (rows ?? []).filter((r) => isMatch(r, tolerancePct)).length;
  return { matched, total, rate: total > 0 ? pct(matched, total) : null };
}

export interface WeightedMatchRate {
  /** 一致行的权重合计（scale 4） */
  matchedQty: string;
  /** 权重合计（scale 4） */
  totalQty: string;
  rows: number;
  rate: number | null;
}

export function qtyWeightedMatchRate(rows: AccuracyRow[], tolerancePct: number): WeightedMatchRate {
  let matchedQty = "0.0000";
  let totalQty = "0.0000";
  for (const r of rows ?? []) {
    const w0 = absDec(dSub(r.expected, 0, 4));
    const w = dCmp(w0, 0) > 0 ? w0 : absDec(dSub(r.actual, 0, 4));
    totalQty = dAdd(totalQty, w, 4);
    if (isMatch(r, tolerancePct)) matchedQty = dAdd(matchedQty, w, 4);
  }
  return { matchedQty, totalQty, rows: rows?.length ?? 0, rate: pct(matchedQty, totalQty) };
}

export interface StagingPassRate {
  ok: number;
  rejected: number;
  total: number;
  rate: number | null;
}

export function stagingPassRate(input: { ok: number; rejected: number }): StagingPassRate {
  const ok = Math.max(0, Math.trunc(input.ok || 0));
  const rejected = Math.max(0, Math.trunc(input.rejected || 0));
  const total = ok + rejected;
  return { ok, rejected, total, rate: total > 0 ? pct(ok, total) : null };
}
