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
  if (coverage.covered != null && coverage.total != null) {
    if (coverage.total <= 0) return null;
    return Math.round((coverage.covered / coverage.total) * 100);
  }
  return coverage.percent == null ? null : Math.round(coverage.percent);
}

export function coverageText(coverage?: VisualCoverage): string | null {
  if (!coverage) return null;
  const pct = coveragePercent(coverage);
  const count =
    coverage.covered != null && coverage.total != null
      ? `${coverage.covered.toLocaleString("zh-CN")}/${coverage.total.toLocaleString("zh-CN")}`
      : null;
  return [coverage.label, count, pct == null ? null : `${pct}%`].filter(Boolean).join(" · ") || null;
}

