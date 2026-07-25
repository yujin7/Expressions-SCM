import { describe, expect, it } from "vitest";
import { backtest, fvaLabel } from "@/server/rules/backtest";

/**
 * FVA（预测价值增量）——回测的「所以呢」。
 *
 * WAPE 只说明误差多大，回答不了真正该问的：**这套预测比「下月＝上月」强吗？**
 * 一项 30 万+ 预测的研究里 52% 不如随机游走，即多数预测流程在做负功。
 * 这里最关键的一条测试是「模型输了要照实说」——一个只会报喜的指标毫无用处，
 * 而报喜是最容易不小心写出来的实现（比如把 FVA 钳到 ≥0，或用「基本持平」糊过去）。
 */

const ym = (i: number) => `2026-${String((i % 12) + 1).padStart(2, "0")}`;
const toSeries = (qty: number[]) => qty.map((q, i) => ({ ym: ym(i), qty: q }));

describe("backtest FVA：与朴素预测（随机游走）对比", () => {
  it("朴素基准取的是「上一期实际」，且与模型看到同一信息集", () => {
    const series = toSeries([10, 20, 30, 40, 50]);
    // 模型固定返回 0，便于单看 naive 取值是否正确
    const r = backtest(series, () => 0, 3);
    expect(r.points.map((p) => p.ym)).toEqual([ym(3), ym(4)]);
    // 第 3 期(40) 的朴素预测 = 第 2 期实际 30；第 4 期(50) 的 = 40
    expect(r.points.map((p) => p.naive)).toEqual([30, 40]);
  });

  it("模型完美时 FVA 为正——朴素误差全额转化为增益", () => {
    const series = toSeries([10, 20, 30, 40, 50]);
    const perfect = (h: number[]) => h[h.length - 1] + 10; // 恰好命中线性趋势
    const r = backtest(series, perfect, 3);
    expect(r.wape).toBe(0);
    expect(r.naiveWape).toBeGreaterThan(0);
    expect(r.fva).toBe(r.naiveWape);
    expect(fvaLabel(r.fva, r.naiveWape, r.wape)).toContain("预测有效");
  });

  it("模型不如朴素时 FVA 必须为负，并明说「做负功」——不许粉饰", () => {
    const series = toSeries([100, 100, 100, 100, 100]); // 平稳序列，朴素几乎无误差
    const bad = () => 300; // 模型离谱高估
    const r = backtest(series, bad, 3);
    expect(r.naiveWape).toBe(0);
    expect(r.wape).toBeGreaterThan(0);
    expect(r.fva).toBeLessThan(0);

    const label = fvaLabel(r.fva, r.naiveWape, r.wape);
    expect(label).toContain("负功");
    // 必须给可执行的出路，而不是只报个坏消息
    expect(label).toContain("建议回到近三月日均口径");
    // 反向断言：不得出现任何把失败说成中性的措辞
    expect(label).not.toContain("持平");
    expect(label).not.toContain("有效");
  });

  it("模型与朴素相当时如实报「持平」，不吹成有效", () => {
    const series = toSeries([100, 100, 100, 100, 100]);
    const same = (h: number[]) => h[h.length - 1]; // 就是朴素本身
    const r = backtest(series, same, 3);
    expect(r.fva).toBe(0);
    const label = fvaLabel(r.fva, r.naiveWape, r.wape);
    expect(label).toContain("持平");
    expect(label).not.toContain("预测有效");
  });

  it("样本不足时不给结论（诚实降级，不拿 0 当「持平」）", () => {
    const r = backtest(toSeries([10, 20]), () => 15, 3);
    expect(r.n).toBe(0);
    expect(r.fva).toBeNull();
    expect(r.naiveWape).toBeNull();
    expect(fvaLabel(r.fva, r.naiveWape, r.wape)).toContain("样本不足");
  });

  it("全零实际序列不产生除零或 NaN", () => {
    const r = backtest(toSeries([0, 0, 0, 0, 0]), () => 0, 3);
    expect(r.wape).toBeNull();
    expect(r.naiveWape).toBeNull();
    expect(r.fva).toBeNull();
    expect(Number.isNaN(r.fva as unknown as number)).toBe(false);
  });
});
