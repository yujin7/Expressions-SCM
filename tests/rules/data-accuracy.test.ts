/** D65 数据质量准确率（rules/data-accuracy.ts） */
import { describe, expect, it } from "vitest";
import { dailyMatchRate, qtyWeightedMatchRate, stagingPassRate } from "@/server/rules/data-accuracy";

describe("dailyMatchRate", () => {
  it("容差 1%：|差| ≤ 1% × max(两侧) 记一致；两侧皆 0 恒一致", () => {
    const r = dailyMatchRate([
      { expected: "100", actual: "100" },
      { expected: "100", actual: "101" },   // 1% 边界含
      { expected: "100", actual: "102" },   // 2% 不一致
      { expected: "0", actual: "0" },
      { expected: "0", actual: "1" },       // 不一致
    ], 1);
    expect(r).toEqual({ matched: 3, total: 5, rate: 60 });
  });
  it("容差 0 = 严格相等；空输入 rate null", () => {
    expect(dailyMatchRate([{ expected: 10, actual: "10.0000" }, { expected: 10, actual: 10.0001 }], 0)).toEqual({ matched: 1, total: 2, rate: 50 });
    expect(dailyMatchRate([], 1)).toEqual({ matched: 0, total: 0, rate: null });
  });
});

describe("qtyWeightedMatchRate", () => {
  it("按 |expected| 加权；expected 为 0 的行按 |actual| 计权", () => {
    const r = qtyWeightedMatchRate([
      { expected: "900", actual: "900" },
      { expected: "100", actual: "150" },
      { expected: "0", actual: "50" },
    ], 1);
    expect(r).toEqual({ matchedQty: "900.0000", totalQty: "1050.0000", rows: 3, rate: 85.71 });
  });
  it("总权重 0 → rate null", () => {
    expect(qtyWeightedMatchRate([{ expected: 0, actual: 0 }], 1).rate).toBeNull();
  });
});

describe("stagingPassRate", () => {
  it("ok/(ok+rejected)；总数 0 → null；负数/非整数归零截断", () => {
    expect(stagingPassRate({ ok: 98, rejected: 2 })).toEqual({ ok: 98, rejected: 2, total: 100, rate: 98 });
    expect(stagingPassRate({ ok: 0, rejected: 0 }).rate).toBeNull();
    expect(stagingPassRate({ ok: -3, rejected: 1.9 })).toEqual({ ok: 0, rejected: 1, total: 1, rate: 0 });
  });
});
