/** rules/volatility.ts：CV/XYZ 唯一权威——含与 report/segmentation.ts 旧本地实现的数值等价证明 */
import { describe, expect, it } from "vitest";
import { classifyXyz, cv } from "@/server/rules/volatility";

/** 旧 segmentation.ts 本地实现（抽出前原样复刻，作为等价基准） */
function legacyCv(quantities: number[], mean: number): number {
  if (mean <= 0) return 0;
  const n = quantities.length;
  const variance = quantities.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n;
  return Math.sqrt(variance) / mean;
}
function legacyXyz(quantities: number[], mean: number): "X" | "Y" | "Z" {
  if (mean <= 0) return "Z";
  const c = legacyCv(quantities, mean);
  if (c <= 0.5) return "X";
  if (c <= 1.0) return "Y";
  return "Z";
}

describe("cv", () => {
  it("总体标准差口径（除以 n）", () => {
    expect(cv([10, 10, 10, 10, 10, 10])).toBe(0);
    // [2,4,4,4,5,5,7,9] 总体 σ=2，均值 5 → 0.4
    expect(cv([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(0.4, 10);
  });
  it("样本口径除以 n−1；n<2 → null", () => {
    expect(cv([2, 4, 4, 4, 5, 5, 7, 9], "sample")).toBeCloseTo(Math.sqrt(32 / 7) / 5, 10);
    expect(cv([5], "sample")).toBeNull();
  });
  it("空序列或均值 ≤ 0 → null", () => {
    expect(cv([])).toBeNull();
    expect(cv([0, 0, 0])).toBeNull();
    expect(cv([-1, 1])).toBeNull();
  });
});

describe("classifyXyz", () => {
  it("X/Y/Z 切点 0.5/1.0（含边界）", () => {
    expect(classifyXyz({ series: [10, 10, 10, 10, 10, 10] }).xyz).toBe("X");
    expect(classifyXyz({ series: [2, 4, 4, 4, 5, 5, 7, 9] }).xyz).toBe("X"); // 0.4
    expect(classifyXyz({ series: [0, 0, 0, 10, 10, 10] }).xyz).toBe("Y"); // cv=1.0 边界含
    expect(classifyXyz({ series: [0, 0, 0, 0, 0, 30] }).xyz).toBe("Z");
  });
  it("样本不足（<6 点）返回 null 而不假装 Z", () => {
    const r = classifyXyz({ series: [1, 2, 3] });
    expect(r).toEqual({ xyz: null, cv: null, points: 3, reason: "insufficient_points" });
    expect(classifyXyz({ series: [1, 2, 3], minPoints: 3 }).xyz).not.toBeNull();
  });
  it("无动销（均值 ≤ 0）返回 null", () => {
    expect(classifyXyz({ series: [0, 0, 0, 0, 0, 0] })).toMatchObject({ xyz: null, cv: null, reason: "no_movement" });
  });
  it("非法切点抛错", () => {
    expect(() => classifyXyz({ series: [1, 1, 1, 1, 1, 1], cuts: [1.0, 0.5] })).toThrow(/invalid xyz cuts/);
  });

  it("与 segmentation.ts 旧实现数值等价（null→Z、cv null→0 映射后逐例一致）", () => {
    const cases: number[][] = [
      [10, 10, 10, 10, 10, 10],
      [2, 4, 4, 4, 5, 5],
      [0, 0, 0, 10, 10, 10],
      [0, 0, 0, 0, 0, 30],
      [0, 0, 0, 0, 0, 0],
      [100, 0, 100, 0, 100, 0],
      [3, 7, 2, 9, 4, 5],
      [1, 1, 1, 1, 1, 50],
      [12.5, 0.25, 8, 8, 8, 8],
    ];
    for (const series of cases) {
      const mean = series.reduce((a, b) => a + b, 0) / series.length;
      const r = classifyXyz({ series, cuts: [0.5, 1.0], minPoints: 6 });
      expect(r.xyz ?? "Z").toBe(legacyXyz(series, mean));
      expect(Math.round((r.cv ?? 0) * 100) / 100).toBe(Math.round(legacyCv(series, mean) * 100) / 100);
    }
    // 无月份窗口（空序列）：旧实现 mean=0 → Z / cv 0；新实现 null → 映射同值
    const empty = classifyXyz({ series: [], minPoints: 6 });
    expect(empty.xyz ?? "Z").toBe(legacyXyz([], 0));
    expect(empty.cv ?? 0).toBe(legacyCv([], 0));
  });
});
