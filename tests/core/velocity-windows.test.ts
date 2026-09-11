/** core/velocity.ts 新增窗口汇总（windowSums / dailyAvgFromWindow）——既有导出不变 */
import { describe, expect, it } from "vitest";
import { DEFAULT_VELOCITY_WINDOWS, calendarMonthWindow, dailyAvgFromWindow, dailyFromWindow, lastMonths, windowSums } from "@/server/core/velocity";

const day = (i: number) => new Date(Date.parse("2026-08-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);

describe("calendarMonthWindow", () => {
  it("六个自然月按实际日历计数，包含闰日与跨年，不改历史三月91天函数", () => {
    expect(calendarMonthWindow("2026-06", 6)).toMatchObject({ startDay: "2026-01-01", endDayExclusive: "2026-07-01", days: 181 });
    expect(calendarMonthWindow("2024-06", 6).days).toBe(182);
    expect(calendarMonthWindow("2026-09", 6).days).toBe(183);
    expect(calendarMonthWindow("2026-12", 2)).toEqual({ months: ["2026-11", "2026-12"], startDay: "2026-11-01", endDayExclusive: "2027-01-01", days: 61 });
    expect(dailyFromWindow(910)).toBe(10);
  });
  it("无效月份与窗口拒绝，不静默返回错误分母", () => {
    for (const ym of ["2026-00", "2026-13", "2026-6", "", "2026-06-01"]) expect(() => calendarMonthWindow(ym, 6)).toThrow("月销窗口无效");
    for (const n of [0, -1, 1.5, 121, Number.NaN]) expect(() => calendarMonthWindow("2026-06", n)).toThrow("月销窗口无效");
  });
});

describe("windowSums", () => {
  it("窗口 w 覆盖 (asOf − w, asOf] 含锚点日；缺省锚点 = 序列最大日", () => {
    const series = Array.from({ length: 40 }, (_, i) => ({ date: day(i), qty: 1 })); // 08-01 .. 09-09
    const s = windowSums(series);
    expect(DEFAULT_VELOCITY_WINDOWS).toEqual([1, 7, 15, 30]);
    expect(s).toEqual({ 1: 1, 7: 7, 15: 15, 30: 30 });
  });
  it("显式 asOf：锚点后数据不计，缺天按 0；decimal 累加无浮点误差", () => {
    const series = [
      { date: day(0), qty: "0.1" }, { date: day(1), qty: "0.2" }, { date: day(2), qty: "0.3" },
      { date: `${day(2)}T12:00:00.000Z`, qty: "0.4" }, // 同日累加、ISO 串取前 10 位
      { date: day(5), qty: "100" },
    ];
    expect(windowSums(series, [1, 3, 7], day(2))).toEqual({ 1: 0.7, 3: 1, 7: 1 });
    expect(windowSums(series, [1], day(3))).toEqual({ 1: 0 });
  });
  it("空序列且无 asOf → 全 0；窗口 0 → 0", () => {
    expect(windowSums([], [1, 7])).toEqual({ 1: 0, 7: 0 });
    expect(windowSums([{ date: day(0), qty: 5 }], [0])).toEqual({ 0: 0 });
  });
});

describe("dailyAvgFromWindow", () => {
  it("sum/days；days ≤ 0 → 0", () => {
    expect(dailyAvgFromWindow(30, 30)).toBe(1);
    expect(dailyAvgFromWindow(7, 0)).toBe(0);
    expect(dailyAvgFromWindow(Number.NaN, 7)).toBe(0);
  });
  it("既有口径未受影响", () => {
    expect(dailyFromWindow(910)).toBeCloseTo(10, 5);
    expect(lastMonths("2026-07", 2)).toEqual(["2026-06", "2026-07"]);
  });
});
