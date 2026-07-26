/** Wave BB 销速口径唯一权威测试（core/velocity.ts） */
import { describe, expect, it } from "vitest";
import { DAILY_WINDOW_DAYS, DAYS_PER_MONTH, dailyFromWindow, lastMonths, monthlyToDaily } from "@/server/core/velocity";

describe("velocity 口径", () => {
  it("lastMonths 由最新月回推 N 月，升序", () => {
    expect(lastMonths("2026-07", 3)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(lastMonths("2026-01", 3)).toEqual(["2025-11", "2025-12", "2026-01"]); // 跨年
  });
  it("窗口日均除以 91（唯一报表口径）", () => {
    expect(DAILY_WINDOW_DAYS).toBe(91);
    expect(dailyFromWindow(910)).toBeCloseTo(10, 5);
  });
  it("月折日均除以 30.4（仅预测折算）", () => {
    expect(DAYS_PER_MONTH).toBe(30.4);
    expect(monthlyToDaily(304)).toBeCloseTo(10, 5);
  });
});
