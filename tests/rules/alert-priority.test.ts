/** 预警互斥与优先级分（rules/alert-priority.ts） */
import { describe, expect, it } from "vitest";
import { ALERT_KINDS, pickPrimaryAlert, priorityScore } from "@/server/rules/alert-priority";

describe("pickPrimaryAlert", () => {
  it("固定优先级 out_of_stock > spike > low_stock > near_expiry > overstock", () => {
    expect(ALERT_KINDS).toEqual(["out_of_stock", "spike", "low_stock", "near_expiry", "overstock"]);
    expect(pickPrimaryAlert({ outOfStock: true, spike: true, lowStock: true, nearExpiry: true, overstock: true }))
      .toEqual({ primary: "out_of_stock", tags: ["spike", "low_stock", "near_expiry", "overstock"] });
    expect(pickPrimaryAlert({ spike: true, lowStock: true })).toEqual({ primary: "spike", tags: ["low_stock"] });
    expect(pickPrimaryAlert({ overstock: true, nearExpiry: true })).toEqual({ primary: "near_expiry", tags: ["overstock"] });
  });
  it("无命中 → primary null，tags 空", () => {
    expect(pickPrimaryAlert({})).toEqual({ primary: null, tags: [] });
    expect(pickPrimaryAlert({ outOfStock: false })).toEqual({ primary: null, tags: [] });
  });
});

describe("priorityScore", () => {
  it("= 日均销 × max(0, alertDays − coverDays)，decimal 字符串 scale 4", () => {
    expect(priorityScore({ dailyAvg: "2.5", alertDays: 50, coverDays: "10" })).toBe("100.0000");
    expect(priorityScore({ dailyAvg: 3, alertDays: 50, coverDays: 49.5 })).toBe("1.5000");
  });
  it("可销天数 ≥ 阈值 → 0；无销速/无效值 → 0", () => {
    expect(priorityScore({ dailyAvg: "2.5", alertDays: 50, coverDays: "80" })).toBe("0.0000");
    expect(priorityScore({ dailyAvg: null, alertDays: 50, coverDays: "10" })).toBe("0.0000");
    expect(priorityScore({ dailyAvg: 1, alertDays: 50, coverDays: null })).toBe("0.0000");
    expect(priorityScore({ dailyAvg: 1, alertDays: 50, coverDays: Number.POSITIVE_INFINITY })).toBe("0.0000");
    expect(priorityScore({ dailyAvg: -1, alertDays: 50, coverDays: 1 })).toBe("0.0000");
  });
});
