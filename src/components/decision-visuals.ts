/**
 * 决策可视化的客户端安全语义层。
 *
 * 颜色表达固定业务语义，不能按页面随意换色；同一图仍须同时提供文字/形状提示，
 * 避免颜色成为唯一信息载体。
 */
export const VISUAL_COLOR = {
  primary: "#2563eb",
  compare: "#0891b2",
  positive: "#16803c",
  warning: "#b45309",
  critical: "#c2413b",
  neutral: "#64748b",
  muted: "#cbd5e1",
  accent: "#7c3aed",
} as const;

export const SERIES_COLORS = [
  VISUAL_COLOR.primary,
  VISUAL_COLOR.compare,
  VISUAL_COLOR.warning,
  VISUAL_COLOR.accent,
  VISUAL_COLOR.positive,
  "#be185d",
  "#4d7c0f",
  "#0369a1",
] as const;

export type VisualState = "ready" | "loading" | "empty" | "error" | "insufficient";

export interface VisualCoverage {
  /** 已覆盖的实体或记录数 */
  covered?: number;
  /** 应覆盖的实体或记录数 */
  total?: number;
  /** 已计算好的百分比；仅在没有分子/分母时使用 */
  percent?: number;
  label?: string;
}

export function coveragePercent(coverage?: VisualCoverage): number | null {
  if (!coverage) return null;
  if (coverage.covered != null || coverage.total != null) {
    const { covered, total } = coverage;
    if (covered == null || total == null || !Number.isSafeInteger(covered) ||
      !Number.isSafeInteger(total) || covered < 0 || total <= 0 || covered > total) return null;
    // The progress geometry uses the real fraction; rounding belongs only to its label.
    return (covered / total) * 100;
  }
  const pct = coverage.percent;
  return pct == null || !Number.isFinite(pct) || pct < 0 || pct > 100 ? null : pct;
}

export function coverageText(coverage?: VisualCoverage): string | null {
  if (!coverage) return null;
  const pct = coveragePercent(coverage);
  const count =
    coverage.covered != null && coverage.total != null &&
    Number.isSafeInteger(coverage.covered) && Number.isSafeInteger(coverage.total) &&
    coverage.covered >= 0 && coverage.total >= 0
      ? `${coverage.covered.toLocaleString("zh-CN")}/${coverage.total.toLocaleString("zh-CN")}`
      : null;
  const hasValues = coverage.covered != null || coverage.total != null || coverage.percent != null;
  const rate = pct == null ? (hasValues ? "覆盖率未知／待核对" : null)
    : pct > 0 && pct < 0.1 ? "<0.1%"
      : pct > 99.9 && pct < 100 ? ">99.9%"
        : `${Number(pct.toFixed(1))}%`;
  return [coverage.label, count, rate].filter(Boolean).join(" · ") || null;
}

/** Explicit decade ticks avoid Recharts' auto-domain rounding duplicate log ticks.
 * A nonpositive observation gets a separate left position, never a fixed floor that
 * can collide with a legitimate small positive value. This changes geometry only.
 */
export function positiveLogAxis(values: readonly number[]) {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const hasNonpositive = values.some((v) => Number.isFinite(v) && v <= 0);
  const min = positive.length ? Math.min(...positive) : 0.1;
  const max = positive.length ? Math.max(...positive) : 1;
  const lo = Math.max(-323, Math.floor(Math.log10(min)) - 1);
  const hi = Math.min(308, Math.max(lo + 2, Math.ceil(Math.log10(max))));
  const domain: [number, number] = [Math.min(10 ** lo, min), Math.max(10 ** hi, max)];
  const placeholder = domain[0];
  const step = Math.max(1, Math.ceil((hi - lo) / 5));
  const ticks = [domain[0]];
  for (let exponent = lo + step; exponent < hi; exponent += step) ticks.push(10 ** exponent);
  ticks.push(domain[1]);
  return {
    domain, ticks, placeholder,
    formatTick: (value: number): string => {
      if (hasNonpositive && value === placeholder) return "无正日销";
      return value < 0.01 || value >= 10000 ? value.toExponential(0) : String(value);
    },
  };
}
