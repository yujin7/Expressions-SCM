/**
 * E4-03 到货日历的日期纯函数（不涉库）：
 * - addDays 走 UTC 定点运算，必须跨月/跨年/跨闰日不漂；
 * - weekdayOf 中文星期映射正确；
 * - diffDays 计算区间跨度（服务层用它做 MAX_RANGE_DAYS 闸门）。
 * 夏令时不影响：业务日锚点是 Asia/Shanghai（无 DST），运算全在 UTC。
 */
import { describe, expect, it } from "vitest";
import { addDays, diffDays, weekdayOf } from "@/server/modules/report/inbound-calendar";

describe("inbound-calendar 日期纯函数", () => {
  it("addDays 跨月/跨年/闰日均不漂", () => {
    expect(addDays("2026-07-24", 14)).toBe("2026-08-07");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // 闰年
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // 平年
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-07-24", 0)).toBe("2026-07-24");
  });

  it("weekdayOf 映射中文星期", () => {
    expect(weekdayOf("2026-07-24")).toBe("周五");
    expect(weekdayOf("2026-07-25")).toBe("周六");
    expect(weekdayOf("2026-07-26")).toBe("周日");
    expect(weekdayOf("2026-07-27")).toBe("周一");
  });

  it("diffDays 返回 b−a 的天数（同日=0，可为负）", () => {
    expect(diffDays("2026-07-24", "2026-08-07")).toBe(14);
    expect(diffDays("2026-07-24", "2026-07-24")).toBe(0);
    expect(diffDays("2026-08-07", "2026-07-24")).toBe(-14);
  });

  it("逐日迭代覆盖闭区间全部自然日（服务层分桶依赖此不变量）", () => {
    const from = "2026-02-26";
    const to = "2026-03-02";
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    expect(days).toEqual(["2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(days.length).toBe(diffDays(from, to) + 1);
  });
});
