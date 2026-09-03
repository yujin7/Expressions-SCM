/** 预警互斥与优先级分（rules/alert-priority.ts） */
import { describe, expect, it } from "vitest";
import { ALERT_KINDS, PRIORITY_SCORE_FORMULA, pickPrimaryAlert, priorityScore } from "@/server/rules/alert-priority";

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

describe("priorityScore（W2：score + terms + formula）", () => {
  it("= 日均销 × max(0, alertDays − coverDays)，decimal 字符串 scale 4；terms 逐项可解释", () => {
    const r = priorityScore({ dailyAvg: "2.5", alertDays: 50, coverDays: "10" });
    expect(r.score).toBe("100.0000");
    expect(r.terms).toEqual({ dailyAvg: "2.5000", alertDays: 50, coverDays: "10.0000", gapDays: "40.0000" });
    expect(r.formula).toBe(PRIORITY_SCORE_FORMULA);
    expect(r.formula).toContain("日均销");
    expect(priorityScore({ dailyAvg: 3, alertDays: 50, coverDays: 49.5 }).score).toBe("1.5000");
    expect(priorityScore({ dailyAvg: 3, alertDays: 50, coverDays: 49.5 }).terms.gapDays).toBe("0.5000");
  });
  it("可销天数 ≥ 阈值 → 0 分、gapDays 0；无销速/无效值 → 0 分，terms 如实回填 null", () => {
    const over = priorityScore({ dailyAvg: "2.5", alertDays: 50, coverDays: "80" });
    expect(over.score).toBe("0.0000");
    expect(over.terms.gapDays).toBe("0.0000");
    const noDaily = priorityScore({ dailyAvg: null, alertDays: 50, coverDays: "10" });
    expect(noDaily.score).toBe("0.0000");
    expect(noDaily.terms).toEqual({ dailyAvg: null, alertDays: 50, coverDays: "10.0000", gapDays: "0.0000" });
    const noCover = priorityScore({ dailyAvg: 1, alertDays: 50, coverDays: null });
    expect(noCover.score).toBe("0.0000");
    expect(noCover.terms.coverDays).toBeNull();
    expect(priorityScore({ dailyAvg: 1, alertDays: 50, coverDays: Number.POSITIVE_INFINITY }).score).toBe("0.0000");
    expect(priorityScore({ dailyAvg: -1, alertDays: 50, coverDays: 1 }).score).toBe("0.0000");
  });
});
