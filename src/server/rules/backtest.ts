/**
 * E7-05 预测回测（纯函数）。
 *
 * 问题：系统在用 Holt 预测驱动展示，却从未回答"它到底准不准"——没有预测误差跟踪，
 * 也就无法判断该不该信它，更无法据此调整安全库存（顶级系统用预测准确度反向调安全库存）。
 *
 * 难点与解法：**我们从未存过历史预测**（没有 forecast_snapshots 表）。
 * 但预测误差不需要历史快照也能算——用**滚动回测**（walk-forward backtest）：
 * 对每个月 M，只用 M 之前的数据跑一次预测，与 M 的实际值比较。
 * 这比"存下每次预测再回看"更严格：它复现了"当时只知道那么多"的信息集，
 * 且对全部历史一次性可算，无需等待数据积累。
 *
 * 指标（全部为标准定义）：
 * - MAPE  = mean(|实际−预测| / 实际)，仅统计实际>0 的期（实际=0 时 MAPE 无定义）；
 * - WAPE  = Σ|实际−预测| / Σ实际（对零值稳健，电商稀疏序列更可信，故同时给出）；
 * - Bias  = Σ(预测−实际) / Σ实际（>0 系统性高估，<0 低估）；
 * - 命中率 = |误差|/实际 ≤ tolerance 的期数占比。
 */

export interface BacktestPoint {
  ym: string;
  actual: number;
  forecast: number;
  /** 误差 = 预测 − 实际（正=高估） */
  error: number;
  /** 绝对百分误差；实际=0 时为 null */
  ape: number | null;
}

export interface BacktestResult {
  points: BacktestPoint[];
  /** 参与统计的期数（需要足够历史才能起测） */
  n: number;
  mape: number | null;
  wape: number | null;
  bias: number | null;
  hitRate: number | null;
  /** 诚实标注：样本太少时结论不可用 */
  reliable: boolean;
  note: string;
}

/**
 * 滚动回测。
 * @param monthly  月度实际值（升序）
 * @param forecastFn 给定历史前缀，返回下一期预测（注入 rules/forecast 的 forecastDaily 以复用同一算法）
 * @param minHistory 起测所需的最少历史期数（Holt 至少 3 期才走统计法）
 * @param tolerance 命中率容差，默认 0.2（±20%）
 */
export function backtest(
  monthly: { ym: string; qty: number }[],
  forecastFn: (history: number[]) => number,
  minHistory = 3,
  tolerance = 0.2,
): BacktestResult {
  const series = monthly.filter((m) => Number.isFinite(m.qty));
  const points: BacktestPoint[] = [];

  for (let i = minHistory; i < series.length; i++) {
    const history = series.slice(0, i).map((m) => m.qty);
    const forecast = Math.max(0, forecastFn(history));
    const actual = series[i].qty;
    const error = forecast - actual;
    points.push({
      ym: series[i].ym,
      actual,
      forecast: Math.round(forecast * 100) / 100,
      error: Math.round(error * 100) / 100,
      ape: actual > 0 ? Math.abs(error) / actual : null,
    });
  }

  const n = points.length;
  if (n === 0) {
    return {
      points, n: 0, mape: null, wape: null, bias: null, hitRate: null,
      reliable: false,
      note: `历史不足：滚动回测需至少 ${minHistory + 1} 个月数据`,
    };
  }

  const apes = points.map((p) => p.ape).filter((v): v is number => v != null);
  const sumActual = points.reduce((a, p) => a + p.actual, 0);
  const sumAbsErr = points.reduce((a, p) => a + Math.abs(p.error), 0);
  const sumErr = points.reduce((a, p) => a + p.error, 0);
  const hits = apes.filter((v) => v <= tolerance).length;

  const r2 = (v: number) => Math.round(v * 1000) / 1000;
  const reliable = n >= 3;
  return {
    points,
    n,
    mape: apes.length ? r2(apes.reduce((a, b) => a + b, 0) / apes.length) : null,
    wape: sumActual > 0 ? r2(sumAbsErr / sumActual) : null,
    bias: sumActual > 0 ? r2(sumErr / sumActual) : null,
    hitRate: apes.length ? r2(hits / apes.length) : null,
    reliable,
    note: reliable
      ? `基于 ${n} 期滚动回测（每期仅用其之前的数据预测）`
      : `仅 ${n} 期可回测，结论参考价值有限（建议积累到 3 期以上）`,
  };
}

/** 偏差方向的中文解读——供 UI 直接展示 */
export function biasLabel(bias: number | null): string {
  if (bias == null) return "无法判定";
  if (bias > 0.1) return `系统性高估 ${(bias * 100).toFixed(1)}%（会导致备货偏多）`;
  if (bias < -0.1) return `系统性低估 ${(Math.abs(bias) * 100).toFixed(1)}%（会导致断货风险）`;
  return `基本无系统性偏差（${(bias * 100).toFixed(1)}%）`;
}
