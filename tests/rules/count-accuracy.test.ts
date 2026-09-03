/** IRA 轨 A 盘点命中率（rules/count-accuracy.ts） */
import { describe, expect, it } from "vitest";
import { countHitRate } from "@/server/rules/count-accuracy";

describe("countHitRate", () => {
  it("默认容差 0：账实相等记命中；rate = hits/lines × 100（2dp）", () => {
    const r = countHitRate([
      { bookQty: "100.0000", countedQty: "100" },
      { bookQty: "50", countedQty: "49.5" },
      { bookQty: 0, countedQty: 0 },
    ]);
    expect(r).toEqual({ lines: 3, hits: 2, rate: 66.67 });
  });
  it("全局绝对容差：|差| ≤ 容差记命中（正负对称）", () => {
    const lines = [
      { bookQty: "100", countedQty: "101" },
      { bookQty: "100", countedQty: "99" },
      { bookQty: "100", countedQty: "102" },
    ];
    expect(countHitRate(lines, 1)).toEqual({ lines: 3, hits: 2, rate: 66.67 });
    expect(countHitRate(lines, "2.0000").hits).toBe(3);
    expect(countHitRate(lines, -5).hits).toBe(0); // 负容差按 0
  });
  it("空输入 rate null", () => {
    expect(countHitRate([])).toEqual({ lines: 0, hits: 0, rate: null });
  });
});
