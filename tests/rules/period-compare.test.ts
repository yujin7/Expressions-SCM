/** 环比比较（rules/period-compare.ts） */
import { describe, expect, it } from "vitest";
import { momPct, momPointDiff } from "@/server/rules/period-compare";

describe("momPct", () => {
  it("(current − previous)/previous × 100，2dp，支持 decimal 字符串与 number", () => {
    expect(momPct("120.00", "100.00")).toBe(20);
    expect(momPct(90, 100)).toBe(-10);
    expect(momPct("1.10", "3.00")).toBe(-63.33);
  });
  it("缺上期、上期为 0、非法值 → null（不补零、不除零）", () => {
    expect(momPct(100, null)).toBeNull();
    expect(momPct(null, 100)).toBeNull();
    expect(momPct(100, 0)).toBeNull();
    expect(momPct(100, "0.00")).toBeNull();
    expect(momPct(Number.NaN, 100)).toBeNull();
    expect(momPct("abc", 100)).toBeNull();
  });
});

describe("momPointDiff", () => {
  it("百分点差 2dp；缺项 → null", () => {
    expect(momPointDiff(47.5, 50)).toBe(-2.5);
    expect(momPointDiff("45.25", "45.00")).toBe(0.25);
    expect(momPointDiff(null, 50)).toBeNull();
    expect(momPointDiff(50, undefined)).toBeNull();
  });
});
