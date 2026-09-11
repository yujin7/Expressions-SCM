/** D63 采购降本（rules/cost-saving.ts）：只计降价，涨价另列不轧差 */
import { describe, expect, it } from "vitest";
import { costSaving } from "@/server/rules/cost-saving";

describe("costSaving", () => {
  it("降价：saving = (基线 − 当前) × 数量，金额 scale 2", () => {
    expect(costSaving({ baselineUnitPrice: "10.5000", currentUnitPrice: "9.7500", qty: "1000" }))
      .toEqual({ saving: "750.00", increase: "0.00", unitDiff: "0.7500", comparable: true });
  });
  it("涨价：saving 0，increase 为正数", () => {
    expect(costSaving({ baselineUnitPrice: 10, currentUnitPrice: "10.20", qty: 500 }))
      .toEqual({ saving: "0.00", increase: "100.00", unitDiff: "-0.2000", comparable: true });
  });
  it("持平 → 两项 0；数量 ≤ 0 → 两项 0；缺基线/当前价 → 不可比", () => {
    expect(costSaving({ baselineUnitPrice: 10, currentUnitPrice: 10, qty: 100 })).toMatchObject({ saving: "0.00", increase: "0.00" });
    expect(costSaving({ baselineUnitPrice: 10, currentUnitPrice: 8, qty: 0 })).toMatchObject({ saving: "0.00", increase: "0.00" });
    expect(costSaving({ baselineUnitPrice: null, currentUnitPrice: 8, qty: 10 })).toEqual({ saving: "0.00", increase: "0.00", unitDiff: null, comparable: false });
  });
});
