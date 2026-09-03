/**
 * 销速/月窗口口径唯一权威（Wave BB——终结 lastMonths 8 份复制与 91/30.4 除数分歧）。
 *
 * 纪律：全系统"近 N 月""日均销"必须走本模块，禁止各服务本地重实现（口径漂移根因）。
 * - lastMonths：由数据最新月回推 N 个自然月（升序）。
 * - DAILY_WINDOW_DAYS：3 月窗口的天数基准 = 91（历史约定，保持向后一致）。
 * - dailyFromWindow：窗口销量 → 日均（除以 DAILY_WINDOW_DAYS）。
 * - monthlyToDaily：单月销量 → 日均（除以 DAYS_PER_MONTH=30.4，仅预测折算用，已注明）。
 */

import { type Dec, dAdd } from "@/server/core/decimal";

/** 3 月窗口日均的天数基准（历史约定 91；勿改，多处报表依赖同值可比） */
export const DAILY_WINDOW_DAYS = 91;
/** 单月折日均的自然月天数（仅 Holt 预测把"月销"折"日均"用） */
export const DAYS_PER_MONTH = 30.4;

/** 由数据最新月 maxYm（YYYY-MM）回推 N 个自然月，升序返回 */
export function lastMonths(maxYm: string, n: number): string[] {
  const [y, m] = maxYm.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out.reverse();
}

/** 近 3 月窗口销量 → 日均销（唯一口径，除以 91） */
export function dailyFromWindow(windowQty: number): number {
  return windowQty / DAILY_WINDOW_DAYS;
}

/** 单月销量 → 日均（除以 30.4，仅预测折算，非报表口径） */
export function monthlyToDaily(monthlyQty: number): number {
  return monthlyQty / DAYS_PER_MONTH;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 日销序列窗口汇总（总监计划：1/7/15/30 天窗口并列）——只增导出，不改既有口径。
 * series 为 {date:'YYYY-MM-DD', qty}[]（日期串可为 ISO，取前 10 位）；asOf 缺省取序列最大日期。
 * 窗口 w 覆盖 (asOf − w 天, asOf]，即含锚点日共 w 天；缺天视为 0。
 * 内部用 decimal 累加（禁 float 累加误差），输出 number 供既有 number 口径的消费者直接使用。
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DailyQtyPoint {
  date: string;
  qty: Dec;
}

export const DEFAULT_VELOCITY_WINDOWS = [1, 7, 15, 30] as const;

function shiftDay(ymd: string, delta: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** 各窗口销量合计；无序列且无 asOf 时所有窗口为 0 */
export function windowSums(
  series: DailyQtyPoint[],
  windows: readonly number[] = DEFAULT_VELOCITY_WINDOWS,
  asOf?: string,
): Record<number, number> {
  const byDate = new Map<string, string>();
  let maxDate: string | null = null;
  for (const p of series ?? []) {
    const d = (p?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    byDate.set(d, dAdd(byDate.get(d) ?? "0", p.qty, 4));
    if (maxDate == null || d > maxDate) maxDate = d;
  }
  const anchor = asOf ? asOf.slice(0, 10) : maxDate;
  const out: Record<number, number> = {};
  for (const w of windows) {
    const days = Math.max(0, Math.trunc(w));
    if (!anchor || days === 0) {
      out[w] = 0;
      continue;
    }
    const start = shiftDay(anchor, -days + 1);
    let sum = "0.0000";
    for (const [d, q] of byDate) if (d >= start && d <= anchor) sum = dAdd(sum, q, 4);
    out[w] = Number(sum);
  }
  return out;
}

/** 窗口销量 → 日均（除以窗口天数）；days ≤ 0 → 0 */
export function dailyAvgFromWindow(sum: number, days: number): number {
  return days > 0 && Number.isFinite(sum) ? sum / days : 0;
}
