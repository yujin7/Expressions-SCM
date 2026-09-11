/** D63 订单至交付周期（rules/po-cycle.ts）：Asia/Shanghai 日界、缺项 null、承诺偏差正负 */
import { describe, expect, it } from "vitest";
import { orderToDeliveryDays, shanghaiDay } from "@/server/rules/po-cycle";

describe("shanghaiDay", () => {
  it("UTC 时间按 Asia/Shanghai 截日；纯日期串原样；非法 → null", () => {
    expect(shanghaiDay("2026-08-31T17:00:00.000Z")).toBe("2026-09-01"); // UTC 17:00 = 沪 01:00 次日
    expect(shanghaiDay(new Date("2026-08-31T15:59:59.000Z"))).toBe("2026-08-31");
    expect(shanghaiDay("2026-09-05")).toBe("2026-09-05");
    expect(shanghaiDay("not a date")).toBeNull();
    expect(shanghaiDay(null)).toBeNull();
  });
});

describe("orderToDeliveryDays", () => {
  it("首批/全收天数按业务日相减；承诺偏差 = 首批 − 承诺（正=迟到）", () => {
    const r = orderToDeliveryDays({
      orderedAt: "2026-08-01T02:00:00.000Z",
      firstReceiptAt: "2026-08-11T10:00:00.000Z",
      completedAt: new Date("2026-08-20T10:00:00.000Z"),
      promisedDate: "2026-08-09",
    });
    expect(r).toEqual({ firstDays: 10, fullDays: 19, promiseDeviationDays: 2 });
  });
  it("提前交付偏差为负；跨日界（UTC 16:00 后）计入次日", () => {
    const r = orderToDeliveryDays({
      orderedAt: "2026-08-01T16:30:00.000Z", // 沪 08-02
      firstReceiptAt: "2026-08-05T01:00:00.000Z",
      completedAt: null,
      promisedDate: "2026-08-08",
    });
    expect(r).toEqual({ firstDays: 3, fullDays: null, promiseDeviationDays: -3 });
  });
  it("缺项一律 null", () => {
    expect(orderToDeliveryDays({ orderedAt: null, firstReceiptAt: "2026-08-05", completedAt: undefined, promisedDate: null }))
      .toEqual({ firstDays: null, fullDays: null, promiseDeviationDays: null });
  });
});
