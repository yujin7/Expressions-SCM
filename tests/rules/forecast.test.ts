/** #2 销量预测纯规则测试（rules/forecast.ts） */
import { describe, expect, it } from "vitest";
import { forecastDaily } from "@/server/rules/forecast";

describe("forecastDaily", () => {
  it("空序列 → 0/none", () => {
    const r = forecastDaily([]);
    expect(r.forecastMonthly).toBe(0);
    expect(r.method).toBe("none");
  });

  it("单点 → 均值法", () => {
    const r = forecastDaily([304]);
    expect(r.method).toBe("avg");
    expect(r.forecastDaily).toBeCloseTo(10, 1); // 304/30.4
  });

  it("上升趋势 → trend=up 且预测高于末月", () => {
    const r = forecastDaily([100, 150, 200, 260, 330]);
    expect(r.method).toBe("holt");
    expect(r.trend).toBe("up");
    expect(r.forecastMonthly).toBeGreaterThan(330);
  });

  it("下降趋势 → trend=down 且预测低于末月", () => {
    const r = forecastDaily([500, 400, 320, 250, 200]);
    expect(r.trend).toBe("down");
    expect(r.forecastMonthly).toBeLessThan(200);
  });

  it("平稳序列 → trend=flat", () => {
    const r = forecastDaily([300, 305, 298, 302, 300]);
    expect(r.trend).toBe("flat");
    expect(r.forecastMonthly).toBeGreaterThan(250);
    expect(r.forecastMonthly).toBeLessThan(350);
  });

  it("预测不为负（急剧下降也夹到 0）", () => {
    const r = forecastDaily([1000, 200, 40, 5, 0]);
    expect(r.forecastMonthly).toBeGreaterThanOrEqual(0);
  });

  it("两点 → 加权移动平均，近月权重更高", () => {
    const r = forecastDaily([100, 400]);
    expect(r.method).toBe("wma");
    expect(r.forecastMonthly).toBeCloseTo(300, 0); // (100*1+400*2)/3
    expect(r.trend).toBe("up");
  });
});
