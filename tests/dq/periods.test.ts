/** D65 核对周期键与节奏裁决（纯函数） */
import { describe, expect, it } from "vitest";
import {
  decideCadence, isoWeekKey, isoWeekRange, monthRange, previousPeriodKey, reviewPeriodKeyFor, WEEK_KEY_RE,
} from "@/server/modules/dq/periods";

describe("ISO 周键", () => {
  it("跨年周归属含周四的那一年；周一为一周之始", () => {
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01"); // 2026-01-01 周四
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01"); // 周一，属 2025 年第 1 周
    expect(isoWeekKey("2027-01-03")).toBe("2026-W53"); // 周日，属 2026 年第 53 周
    expect(isoWeekKey("2026-09-03")).toBe("2026-W36");
    expect(WEEK_KEY_RE.test(isoWeekKey("2026-09-03"))).toBe(true);
  });

  it("周键起止为周一~周日，与 isoWeekKey 互逆", () => {
    expect(isoWeekRange("2026-W36")).toEqual({ from: "2026-08-31", through: "2026-09-06" });
    expect(isoWeekRange("2025-W01")).toEqual({ from: "2024-12-30", through: "2025-01-05" });
    expect(isoWeekKey(isoWeekRange("2026-W53").from)).toBe("2026-W53");
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", through: "2026-02-28" });
  });

  it("上一周期与本期键：周核对取上一完整周，月核对取上一完整月", () => {
    expect(previousPeriodKey("week", "2026-W01")).toBe("2025-W52"); // 2025 只有 52 个 ISO 周
    expect(previousPeriodKey("month", "2026-01")).toBe("2025-12");
    expect(reviewPeriodKeyFor("week", "2026-09-03")).toBe("2026-W35");
    expect(reviewPeriodKeyFor("month", "2026-09-03")).toBe("2026-08");
    expect(() => isoWeekRange("2026-W60")).toThrow();
  });
});

describe("decideCadence", () => {
  it("连续 4 周达标才转月核对；中断即回到周核对；不足 4 周恒为周", () => {
    const met = (k: string, m: boolean) => ({ periodKey: k, met: m });
    expect(decideCadence([]).cadence).toBe("week");
    expect(decideCadence([met("2026-W35", true), met("2026-W34", true), met("2026-W33", true)]).cadence).toBe("week");
    const four = [met("2026-W35", true), met("2026-W34", true), met("2026-W33", true), met("2026-W32", true)];
    expect(decideCadence(four)).toMatchObject({ cadence: "month", streak: 4 });
    // 乱序传入也按 periodKey 降序判断
    expect(decideCadence([...four].reverse()).cadence).toBe("month");
    // 最近一周未达标 → streak 0
    expect(decideCadence([met("2026-W35", false), ...four.slice(1)])).toMatchObject({ cadence: "week", streak: 0 });
    // 中间断档 → 只数到断点
    expect(decideCadence([met("2026-W35", true), met("2026-W34", false), met("2026-W33", true), met("2026-W32", true)]))
      .toMatchObject({ cadence: "week", streak: 1 });
  });
});
