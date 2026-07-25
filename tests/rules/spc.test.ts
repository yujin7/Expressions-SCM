/** E7-09 统计异常带测试（逻辑已在 node 中逐例执行验证） */
import { describe, expect, it } from "vitest";
import { computeBands, detectSignals, type SeriesPoint } from "@/server/rules/spc";

const series = (values: number[]): SeriesPoint[] =>
  values.map((value, i) => ({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, value }));

describe("computeBands", () => {
  it("稳健模式用中位数 + MAD×1.4826", () => {
    const b = computeBands([10, 11, 9, 10, 11, 9, 10])!;
    expect(b.center).toBe(10);
    expect(b.sigma).toBeCloseTo(1.4826, 4); // MAD=1
  });

  it("非稳健模式用均值 + 样本标准差（n−1）", () => {
    const b = computeBands([2, 4, 4, 4, 5, 5, 7, 9], { robust: false })!;
    expect(b.center).toBe(5);
    expect(b.sigma).toBeCloseTo(2.1381, 3); // sqrt(32/7)
  });

  it("带层级严格有序", () => {
    const b = computeBands([10, 11, 9, 10, 12, 8, 10])!;
    expect(b.lower3).toBeLessThan(b.lower2);
    expect(b.lower2).toBeLessThan(b.lower1);
    expect(b.lower1).toBeLessThan(b.center);
    expect(b.center).toBeLessThan(b.upper1);
    expect(b.upper1).toBeLessThan(b.upper2);
    expect(b.upper2).toBeLessThan(b.upper3);
  });

  it("样本不足 2 点 → null", () => {
    expect(computeBands([5])).toBeNull();
    expect(computeBands([])).toBeNull();
  });
});

describe("detectSignals", () => {
  it("**样本不足时明确说明，不硬算一条没有统计依据的带**", () => {
    const r = detectSignals(series([10, 12, 11, 9]));
    expect(r.bands).toBeNull();
    expect(r.signals).toEqual([]);
    expect(r.samples).toBe(4);
    expect(r.note).toContain("样本不足");
  });

  it("**σ=0 恒定序列不产生任何信号**——这正是误报的主要来源", () => {
    const r = detectSignals(series(Array(12).fill(10)));
    expect(r.bands!.sigma).toBe(0);
    expect(r.signals).toEqual([]);
    expect(r.note).toContain("σ=0");
  });

  it("R1：单点越 3σ 报 high", () => {
    const r = detectSignals(series([100, 101, 99, 100, 102, 98, 100, 101, 500]));
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0].rule).toBe("R1");
    expect(r.signals[0].severity).toBe("high");
    expect(r.signals[0].index).toBe(8);
    expect(r.signals[0].value).toBe(500);
    expect(r.signals[0].sigmas).toBeGreaterThan(3);
  });

  it("R2：连续 3 点中 2 点越 2σ 报 medium", () => {
    const r = detectSignals(series([50, 52, 48, 50, 52, 48, 50, 52, 48, 50, 57, 57]));
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0].rule).toBe("R2");
    expect(r.signals[0].severity).toBe("medium");
    expect(r.signals[0].index).toBe(11);
  });

  it("R4：连续 8 点同侧报 low（均值漂移）", () => {
    const r = detectSignals(series([10, 12, 8, 11, 9, 13, 7, 10, 14, 15, 14, 16, 15, 14, 15, 16]));
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.signals.every((s) => s.rule === "R4" && s.severity === "low")).toBe(true);
    expect(r.signals.some((s) => s.index === 15)).toBe(true);
  });

  it("**掩蔽效应：非稳健模式下大异常把自己藏进带内，稳健模式抓得住**", () => {
    const data = series([10, 11, 9, 10, 11, 9, 10, 11, 9, 100]);

    const robust = detectSignals(data); // 默认稳健
    const spike = robust.signals.find((s) => s.index === 9);
    expect(spike?.rule).toBe("R1");
    expect(spike?.severity).toBe("high");

    const naive = detectSignals(data, { robust: false });
    // 均值被 100 拉高、σ 被 100 撑大 → 100 自己反而落在 3σ 内，漏报
    expect(naive.signals.find((s) => s.index === 9 && s.rule === "R1")).toBeUndefined();
    expect(naive.bands!.sigma).toBeGreaterThan(robust.bands!.sigma * 10);
  });

  it("一个点只出一条信号（取最严重的），不重复刷屏", () => {
    const r = detectSignals(series([10, 12, 8, 11, 9, 13, 7, 10, 14, 15, 14, 16, 15, 14, 15, 300]));
    const idxs = r.signals.map((s) => s.index);
    expect(new Set(idxs).size).toBe(idxs.length);
    expect(r.signals.find((s) => s.index === 15)!.severity).toBe("high"); // R1 压过 R4
  });

  it("非有限值被过滤，不污染统计", () => {
    const dirty = [
      ...series([10, 11, 9, 10, 11, 9, 10, 11]),
      { date: "2026-06-09", value: NaN },
      { date: "2026-06-10", value: Infinity },
    ];
    const r = detectSignals(dirty);
    expect(r.samples).toBe(8);
    expect(r.bands!.center).toBe(10);
  });

  it("正常序列全部落在带内时明确说无异常", () => {
    const r = detectSignals(series([10, 11, 9, 10, 11, 9, 10, 11, 9, 10]));
    expect(r.signals).toEqual([]);
    expect(r.note).toContain("无统计异常");
  });

  it("baselineWindow 只用最近 N 点建带", () => {
    const data = series([1, 1, 1, 1, 1, 1, 1, 1, 50, 52, 48, 50, 52, 48, 50, 52]);
    const full = detectSignals(data);
    const recent = detectSignals(data, { baselineWindow: 8 });
    expect(recent.bands!.center).toBe(50);
    expect(full.bands!.center).not.toBe(50);
  });

  it("空输入不抛错", () => {
    expect(() => detectSignals([])).not.toThrow();
    // @ts-expect-error 故意传 null 验证运行时健壮性
    expect(() => detectSignals(null)).not.toThrow();
  });
});
