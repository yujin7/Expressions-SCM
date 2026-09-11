/**
 * 需求波动系数与 XYZ 分类（纯函数，唯一权威）——把 report/segmentation.ts 里的本地 CV/XYZ 抽出。
 *
 * 口径（与分层看板历史数值一致，勿改）：
 * - CV = σ / 均值；默认 **总体标准差**（除以 n），`mode:"sample"` 才除以 n−1。
 * - X：CV ≤ cuts[0]（默认 0.5）；Y：≤ cuts[1]（默认 1.0）；Z：其余。
 * - 样本护栏（研究采纳）：点数 < minPoints（默认 6）或均值 ≤ 0（无动销）→ xyz=null、cv=null，
 *   **不假装 Z**。消费者若要沿用旧看板的"无动销=Z"展示，须显式映射 null→Z 并单独计数。
 */

export type XyzClass = "X" | "Y" | "Z";
export type CvMode = "population" | "sample";

/** 变异系数；n=0 或均值 ≤ 0 → null；sample 模式 n<2 → null */
export function cv(series: number[], mode: CvMode = "population"): number | null {
  const vals = series.filter((v) => Number.isFinite(v));
  const n = vals.length;
  if (n === 0) return null;
  if (mode === "sample" && n < 2) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return null;
  const ss = vals.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
  const variance = ss / (mode === "sample" ? n - 1 : n);
  return Math.sqrt(variance) / mean;
}

export interface ClassifyXyzInput {
  series: number[];
  /** [X 上界, Y 上界]，默认 [0.5, 1.0] */
  cuts?: [number, number];
  /** 最少点数，默认 6 */
  minPoints?: number;
  mode?: CvMode;
}

export interface XyzResult {
  xyz: XyzClass | null;
  cv: number | null;
  /** 实际点数 */
  points: number;
  /** 为什么是 null（有值时为 null） */
  reason: "insufficient_points" | "no_movement" | null;
}

export function classifyXyz(input: ClassifyXyzInput): XyzResult {
  const cuts = input.cuts ?? [0.5, 1.0];
  const minPoints = input.minPoints ?? 6;
  if (!(cuts[0] > 0 && cuts[1] > cuts[0])) throw new Error(`invalid xyz cuts: ${cuts.join(",")}`);
  const series = (input.series ?? []).filter((v) => Number.isFinite(v));
  const points = series.length;
  if (points < minPoints) return { xyz: null, cv: null, points, reason: "insufficient_points" };
  const c = cv(series, input.mode ?? "population");
  if (c == null) return { xyz: null, cv: null, points, reason: "no_movement" };
  const xyz: XyzClass = c <= cuts[0] ? "X" : c <= cuts[1] ? "Y" : "Z";
  return { xyz, cv: c, points, reason: null };
}
