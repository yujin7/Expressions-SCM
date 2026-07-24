/**
 * E2-04 交期学习（纯函数）——把「交期」从人工档案的点估计升级为历史分布。
 *
 * 现状：sku_params.normal_lead_days 是人工填的档案值，却被安全库存（R/E2-01）与
 * 最晚下单日推算当铁律用。真实世界里交期是分布：均值会漂、方差决定缓冲、准时率决定信任度。
 *
 * 本模块只做统计与建议，不碰主数据：
 *   - leadTimeStats：由「承诺交期天数 / 实际交期天数」样本算 P50/P90/均值/σ/准时率/平均延误；
 *   - suggestLeadDays：与档案值比对，偏差超容差且样本足够时才给建议值（人工采纳，非自动改档）。
 *
 * 口径约定：
 *   - 分位数用线性插值（R type-7，与 Excel PERCENTILE 一致），小样本下比「取第 k 个」更稳；
 *   - 准时率 = 实际 ≤ 承诺 的比例，**仅统计有承诺交期的样本**（无承诺无从判准时）；
 *   - 平均延误 = 平均(实际 − 承诺)，**正数=延误**、负数=提前，同样仅统计有承诺的样本；
 *   - σ（标准差）用样本标准差（n−1 分母），n<2 时不可信 → null，不假装算得出来。
 *
 * 产出的 P50/σ 未来将喂给 rules/safety-stock.ts 的 leadDays / leadDaysStdev 参数。
 */

/** 一条交期样本：一次 PO→收货的履约记录 */
export interface LeadTimeSample {
  /** 承诺交期天数（下单日→承诺到货日）；无承诺日期时为 null */
  promisedDays: number | null;
  /** 实际交期天数（下单日→实际收货日） */
  actualDays: number;
}

export interface LeadTimeStats {
  /** 有效样本数 */
  n: number;
  /** 实际交期中位数（天） */
  p50: number | null;
  /** 实际交期 P90（天）——排产/安全库存应看的「坏情况」 */
  p90: number | null;
  /** 实际交期均值（天） */
  mean: number | null;
  /** 实际交期样本标准差（天）；n<2 → null */
  stdev: number | null;
  /** 准时率 0~1（实际 ≤ 承诺）；无承诺样本 → null */
  onTimeRate: number | null;
  /** 平均延误天数（正=延误、负=提前）；无承诺样本 → null */
  avgDelayDays: number | null;
}

/** 保留 2 位小数（消除浮点噪音，便于展示与断言） */
const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * 线性插值分位数（R type-7）：h = (n−1)·p，取 floor(h) 与 ceil(h) 两点按小数位插值。
 * values 必须已升序；空数组返回 null。
 */
export function quantile(sorted: number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function leadTimeStats(samples: LeadTimeSample[]): LeadTimeStats {
  const valid = samples.filter((s) => Number.isFinite(s.actualDays));
  const n = valid.length;
  if (n < 1) {
    return { n: 0, p50: null, p90: null, mean: null, stdev: null, onTimeRate: null, avgDelayDays: null };
  }

  const actuals = valid.map((s) => s.actualDays).sort((a, b) => a - b);
  const mean = actuals.reduce((a, b) => a + b, 0) / n;
  const sd =
    n >= 2
      ? Math.sqrt(actuals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
      : null;

  // 准时率/平均延误只在「有承诺交期」的样本上成立
  const promised = valid.filter((s) => s.promisedDays != null && Number.isFinite(s.promisedDays));
  const onTimeRate =
    promised.length > 0
      ? promised.filter((s) => s.actualDays <= (s.promisedDays as number)).length / promised.length
      : null;
  const avgDelayDays =
    promised.length > 0
      ? promised.reduce((a, s) => a + (s.actualDays - (s.promisedDays as number)), 0) / promised.length
      : null;

  const p50 = quantile(actuals, 0.5);
  const p90 = quantile(actuals, 0.9);
  return {
    n,
    p50: p50 == null ? null : r2(p50),
    p90: p90 == null ? null : r2(p90),
    mean: r2(mean),
    stdev: sd == null ? null : r2(sd),
    onTimeRate: onTimeRate == null ? null : Math.round(onTimeRate * 10000) / 10000,
    avgDelayDays: avgDelayDays == null ? null : r2(avgDelayDays),
  };
}

export interface LeadTimeSuggestion {
  /** 建议档案交期（天，整数）；null=不建议改 */
  suggest: number | null;
  /** 可解释理由（无论建不建议都给） */
  reason: string;
}

/**
 * 档案交期建议：只有「样本够 + 偏差超容差」才开口，且给的是 P50 四舍五入值。
 * 人工闸：本函数只产出建议，采纳与否由人点击决定（绝不自动改主数据）。
 */
export function suggestLeadDays(
  current: number | null,
  stats: LeadTimeStats,
  minSamples = 3,
  deviationPct = 20,
): LeadTimeSuggestion {
  if (stats.n < minSamples) {
    return { suggest: null, reason: `样本不足（${stats.n}/${minSamples} 单），不作建议` };
  }
  if (stats.p50 == null) {
    return { suggest: null, reason: "无有效交期样本" };
  }
  const target = Math.round(stats.p50);
  if (current == null || current <= 0) {
    return { suggest: target, reason: `档案未设常规交期，按历史 P50 ${stats.p50} 天建议` };
  }
  const dev = (Math.abs(stats.p50 - current) / current) * 100;
  if (dev <= deviationPct) {
    return { suggest: null, reason: `历史 P50 ${stats.p50} 天与档案 ${current} 天偏差 ${dev.toFixed(0)}%，在容差 ${deviationPct}% 内` };
  }
  if (target === current) {
    return { suggest: null, reason: `历史 P50 ${stats.p50} 天四舍五入后与档案 ${current} 天一致，无需调整` };
  }
  const dir = target > current ? "低估" : "高估";
  return {
    suggest: target,
    reason: `历史 P50 ${stats.p50} 天 vs 档案 ${current} 天，偏差 ${dev.toFixed(0)}% 超容差 ${deviationPct}%（档案${dir}交期），建议改为 ${target} 天`,
  };
}
