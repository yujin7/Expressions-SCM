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
 *
 * ── FVA（预测价值增量）──
 * 上面四个指标只能说明 Holt「误差多大」，回答不了那个真正该问的问题：
 * **它到底比「下月＝上月」这种零成本的朴素预测强吗？**
 * 一项 30 万+ 预测的研究里，52% 的预测不如随机游走——即多数预测流程是在做负功。
 * 所以本模块对每一期同时算朴素预测（naive = 上一期实际值，随机游走），
 * 用同一批期数、同一个 WAPE 口径对比：
 *     FVA = naiveWape − wape   （>0 = Holt 确实加了分；≤0 = 不如照抄上月）
 * FVA ≤ 0 时必须**照实说**，不许粉饰——用不如朴素的模型驱动补货，是在系统性地制造错误决策。
 */

export interface BacktestPoint {
  ym: string;
  actual: number;
  forecast: number;
  /** 误差 = 预测 − 实际（正=高估） */
  error: number;
  /** 绝对百分误差；实际=0 时为 null */
  ape: number | null;
  /** 朴素预测（随机游走：本期预测＝上期实际）——FVA 的对照基准 */
  naive: number;
}

export interface BacktestResult {
  points: BacktestPoint[];
  /** 参与统计的期数（需要足够历史才能起测） */
  n: number;
  mape: number | null;
  wape: number | null;
  bias: number | null;
  hitRate: number | null;
  /** 朴素预测（上期实际）在同一批期数上的 WAPE——FVA 基准 */
  naiveWape: number | null;
  /** FVA = naiveWape − wape。>0 模型加分；≤0 不如照抄上月 */
  fva: number | null;
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
      // 朴素基准与模型看到的信息集完全相同：history 的最后一期即上期实际
      naive: history[history.length - 1],
    });
  }

  const n = points.length;
  if (n === 0) {
    return {
      points, n: 0, mape: null, wape: null, bias: null, hitRate: null,
      naiveWape: null, fva: null,
      reliable: false,
      note: `历史不足：滚动回测需至少 ${minHistory + 1} 个月数据`,
    };
  }

  const apes = points.map((p) => p.ape).filter((v): v is number => v != null);
  const sumActual = points.reduce((a, p) => a + p.actual, 0);
  const sumAbsErr = points.reduce((a, p) => a + Math.abs(p.error), 0);
  const sumErr = points.reduce((a, p) => a + p.error, 0);
  const hits = apes.filter((v) => v <= tolerance).length;

  /* FVA：朴素预测在同一批期数、同一 WAPE 口径下的误差 */
  const sumAbsNaiveErr = points.reduce((a, p) => a + Math.abs(p.naive - p.actual), 0);

  const r2 = (v: number) => Math.round(v * 1000) / 1000;
  const reliable = n >= 3;
  const wape = sumActual > 0 ? r2(sumAbsErr / sumActual) : null;
  const naiveWape = sumActual > 0 ? r2(sumAbsNaiveErr / sumActual) : null;
  return {
    points,
    n,
    mape: apes.length ? r2(apes.reduce((a, b) => a + b, 0) / apes.length) : null,
    wape,
    bias: sumActual > 0 ? r2(sumErr / sumActual) : null,
    hitRate: apes.length ? r2(hits / apes.length) : null,
    naiveWape,
    fva: wape != null && naiveWape != null ? r2(naiveWape - wape) : null,
    reliable,
    note: reliable
      ? `基于 ${n} 期滚动回测（每期仅用其之前的数据预测）`
      : `仅 ${n} 期可回测，结论参考价值有限（建议积累到 3 期以上）`,
  };
}

/**
 * FVA 的中文解读——供 UI 直接展示。
 * 纪律：模型输给朴素预测时必须**明说**并给出行动建议，不许用「基本持平」之类的话糊过去。
 * 用不如「照抄上月」的模型驱动补货，等于在系统性地制造错误决策。
 */
export function fvaLabel(fva: number | null, naiveWape: number | null, wape: number | null): string {
  if (fva == null || naiveWape == null || wape == null) return "样本不足，无法与朴素预测对比";
  const pp = (v: number) => `${(v * 100).toFixed(1)}%`;
  const cmp = `（模型 WAPE ${pp(wape)} vs 朴素 ${pp(naiveWape)}）`;
  if (fva > 0.02) return `预测有效：比「下月＝上月」减少 ${pp(fva)} 误差${cmp}`;
  if (fva < -0.02) {
    return `⚠ 预测在做负功：比「下月＝上月」**多** ${pp(Math.abs(fva))} 误差${cmp}——` +
      `不宜用该预测驱动决策，建议回到近三月日均口径`;
  }
  return `与朴素预测基本持平${cmp}——Holt 未带来可辨识增益，优先怀疑数据质量而非调参`;
}

/** 偏差方向的中文解读——供 UI 直接展示 */
export function biasLabel(bias: number | null): string {
  if (bias == null) return "无法判定";
  if (bias > 0.1) return `系统性高估 ${(bias * 100).toFixed(1)}%（会导致备货偏多）`;
  if (bias < -0.1) return `系统性低估 ${(Math.abs(bias) * 100).toFixed(1)}%（会导致断货风险）`;
  return `基本无系统性偏差（${(bias * 100).toFixed(1)}%）`;
}
