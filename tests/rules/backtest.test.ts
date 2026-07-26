/** E7-05 预测回测纯规则测试 */
import { describe, expect, it } from "vitest";
import { backtest, biasLabel } from "@/server/rules/backtest";

const mk = (qtys: number[]) => qtys.map((q, i) => ({ ym: `2026-${String(i + 1).padStart(2, "0")}`, qty: q }));

describe("backtest 滚动回测", () => {
  it("完美预测 → 误差全为 0，MAPE/WAPE/Bias 均为 0", () => {
    // 预测函数直接返回下一期真值（作弊器）——用于验证指标算法本身
    const series = mk([100, 110, 120, 130, 140]);
    let call = 0;
    const truth = [130, 140];
    const r = backtest(series, () => truth[call++], 3);
    expect(r.n).toBe(2);
    expect(r.mape).toBe(0);
    expect(r.wape).toBe(0);
    expect(r.bias).toBe(0);
    expect(r.hitRate).toBe(1);
  });

  it("只用历史前缀预测（不泄漏未来）", () => {
    const series = mk([10, 20, 30, 40, 50]);
    const seen: number[][] = [];
    backtest(series, (h) => { seen.push([...h]); return 0; }, 3);
    // 第一次回测用前 3 期，第二次用前 4 期——绝不含被预测的那期
    expect(seen[0]).toEqual([10, 20, 30]);
    expect(seen[1]).toEqual([10, 20, 30, 40]);
  });

  it("系统性高估 → bias 为正", () => {
    const series = mk([100, 100, 100, 100, 100]);
    const r = backtest(series, () => 120, 3);
    expect(r.bias!).toBeGreaterThan(0);
    expect(biasLabel(r.bias)).toContain("高估");
  });

  it("系统性低估 → bias 为负并提示断货风险", () => {
    const series = mk([100, 100, 100, 100, 100]);
    const r = backtest(series, () => 80, 3);
    expect(r.bias!).toBeLessThan(0);
    expect(biasLabel(r.bias)).toContain("低估");
  });

  it("实际为 0 的期不进 MAPE（无定义），但仍进 WAPE 分子", () => {
    const series = mk([50, 50, 50, 0, 50]);
    const r = backtest(series, () => 50, 3);
    const zeroPoint = r.points.find((p) => p.actual === 0)!;
    expect(zeroPoint.ape).toBeNull();
    expect(r.mape).not.toBeNull(); // 另一期仍可算
    expect(r.wape).not.toBeNull();
  });

  it("历史不足 → n=0 且诚实说明，不假装有结论", () => {
    const r = backtest(mk([10, 20]), () => 15, 3);
    expect(r.n).toBe(0);
    expect(r.mape).toBeNull();
    expect(r.reliable).toBe(false);
    expect(r.note).toContain("历史不足");
  });

  it("样本少于 3 期时标记不可靠", () => {
    const r = backtest(mk([10, 20, 30, 40]), () => 35, 3);
    expect(r.n).toBe(1);
    expect(r.reliable).toBe(false);
    expect(r.note).toContain("参考价值有限");
  });

  it("命中率按容差统计", () => {
    const series = mk([100, 100, 100, 100, 100]);
    const r = backtest(series, () => 110, 3, 0.2); // 误差 10% ≤ 20% → 全命中
    expect(r.hitRate).toBe(1);
    const r2 = backtest(series, () => 150, 3, 0.2); // 误差 50% > 20% → 全不中
    expect(r2.hitRate).toBe(0);
  });

  it("预测不为负（夹到 0）", () => {
    const r = backtest(mk([10, 10, 10, 10]), () => -50, 3);
    expect(r.points[0].forecast).toBe(0);
  });
});
