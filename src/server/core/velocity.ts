/**
 * 销速/月窗口口径唯一权威（Wave BB——终结 lastMonths 8 份复制与 91/30.4 除数分歧）。
 *
 * 纪律：全系统"近 N 月""日均销"必须走本模块，禁止各服务本地重实现（口径漂移根因）。
 * - lastMonths：由数据最新月回推 N 个自然月（升序）。
 * - DAILY_WINDOW_DAYS：3 月窗口的天数基准 = 91（历史约定，保持向后一致）。
 * - dailyFromWindow：窗口销量 → 日均（除以 DAILY_WINDOW_DAYS）。
 * - monthlyToDaily：单月销量 → 日均（除以 DAYS_PER_MONTH=30.4，仅预测折算用，已注明）。
 */

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
