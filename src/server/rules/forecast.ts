/**
 * #2 销量预测（纯函数）：对月度销量序列做 Holt 线性（二次指数平滑，含趋势项），
 * 预测下一期月销并折算日均——比"近3月÷91"能捕捉上升/下降趋势与近期权重。
 *
 * 口径：电商销量波动大且历史短（通常 <12 月），不做年度季节性（无同月上年样本）；
 * 采用 level+trend 平滑，样本不足时优雅降级为加权/简单均值。
 * 展示层预测，不参与记账，不直接驱动建议量（naive 口径仍为建议驱动，预测供人工判断）。
 */

export type ForecastMethod = "holt" | "wma" | "avg" | "none";

export interface ForecastResult {
  /** 预测下一期月销（≥0） */
  forecastMonthly: number;
  /** 预测日均（月销/30.4） */
  forecastDaily: number;
  /** 趋势方向：up/down/flat（基于平滑趋势分量） */
  trend: "up" | "down" | "flat";
  method: ForecastMethod;
}

const DAYS_PER_MONTH = 30.4;
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * @param monthly 时间升序的月度销量（最早在前）
 */
export function forecastDaily(monthly: number[], alpha = 0.5, beta = 0.3): ForecastResult {
  const series = monthly.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const n = series.length;
  if (n === 0) return { forecastMonthly: 0, forecastDaily: 0, trend: "flat", method: "none" };
  if (n === 1) {
    const m = series[0];
    return { forecastMonthly: round2(m), forecastDaily: round2(m / DAYS_PER_MONTH), trend: "flat", method: "avg" };
  }
  if (n === 2) {
    // 加权移动平均（近月权重更高），趋势由两点差决定
    const wma = (series[0] * 1 + series[1] * 2) / 3;
    const trend: ForecastResult["trend"] = series[1] > series[0] * 1.1 ? "up" : series[1] < series[0] * 0.9 ? "down" : "flat";
    return { forecastMonthly: round2(wma), forecastDaily: round2(wma / DAYS_PER_MONTH), trend, method: "wma" };
  }

  // Holt 线性：level + trend
  let level = series[0];
  let trend = series[1] - series[0];
  for (let i = 1; i < n; i++) {
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  const forecast = Math.max(0, level + trend);
  const trendDir: ForecastResult["trend"] =
    trend > level * 0.03 ? "up" : trend < -level * 0.03 ? "down" : "flat";
  return {
    forecastMonthly: round2(forecast),
    forecastDaily: round2(forecast / DAYS_PER_MONTH),
    trend: trendDir,
    method: "holt",
  };
}
