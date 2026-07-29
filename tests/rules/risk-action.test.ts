/** F 项：风险处置动作判定纯规则测试（rules/risk-action.ts） */
import { describe, expect, it } from "vitest";
import { isSlowMover, suggestRiskAction } from "@/server/rules/risk-action";

const base = {
  minDaysLeft: null,
  cover: 30,
  onHand: 100,
  slowThreshold: 180,
  nearExpiryDays: 90,
  palletRemark: null,
};

describe("suggestRiskAction 优先级", () => {
  it("注记「报废」最高优先（即使效期未到）", () => {
    expect(suggestRiskAction({ ...base, palletRemark: "过期待报废", minDaysLeft: 200 })).toBe("报废评审");
  });
  it("已过期批次 → 报废评审", () => {
    expect(suggestRiskAction({ ...base, minDaysLeft: -5 })).toBe("报废评审");
    expect(suggestRiskAction({ ...base, minDaysLeft: 0 })).toBe("报废评审");
  });
  it("注记「禁售」→ 禁售隔离（先于促销判定）", () => {
    expect(suggestRiskAction({ ...base, palletRemark: "临期禁售", minDaysLeft: 60 })).toBe("禁售隔离");
  });
  it("注记「商务」→ 商务处置", () => {
    expect(suggestRiskAction({ ...base, palletRemark: "商务库存" })).toBe("商务处置");
  });
  it("90 天内到期 + 滞销 → 促销清库；销速尚可 → 优先出库", () => {
    expect(suggestRiskAction({ ...base, minDaysLeft: 60, cover: 400 })).toBe("促销清库");
    expect(suggestRiskAction({ ...base, minDaysLeft: 60, cover: null })).toBe("促销清库"); // 无动销
    expect(suggestRiskAction({ ...base, minDaysLeft: 60, cover: 45 })).toBe("优先出库");
  });
  it("逐 SKU 临期阈值决定动作，不再硬编码 90 天", () => {
    expect(suggestRiskAction({ ...base, minDaysLeft: 150, nearExpiryDays: 180, cover: 45 })).toBe("优先出库");
    expect(suggestRiskAction({ ...base, minDaysLeft: 60, nearExpiryDays: 30, cover: 45 })).toBeNull();
  });
  it("无效期风险但滞销 → 滞销关注；无信号 → null", () => {
    expect(suggestRiskAction({ ...base, cover: 400 })).toBe("滞销关注");
    expect(suggestRiskAction({ ...base, cover: 45 })).toBeNull();
  });
  it("非销售用途不制造滞销动作，但保留效期与注记动作", () => {
    expect(suggestRiskAction({ ...base, cover: null, includeSlowMover: false })).toBeNull();
    expect(suggestRiskAction({
      ...base,
      cover: null,
      minDaysLeft: 60,
      includeSlowMover: false,
    })).toBe("优先出库");
    expect(suggestRiskAction({
      ...base,
      cover: null,
      palletRemark: "临期禁售",
      includeSlowMover: false,
    })).toBe("禁售隔离");
  });
  it("零库存且无注记 → null（不进工作台）", () => {
    expect(suggestRiskAction({ ...base, onHand: 0, minDaysLeft: -3 })).toBeNull();
  });
  it("零库存但有注记 → 仍进工作台（注记优先，如报废流程收尾）", () => {
    expect(suggestRiskAction({ ...base, onHand: 0, palletRemark: "过期待报废" })).toBe("报废评审");
  });
});

describe("isSlowMover", () => {
  it("有库存无动销=滞销；超阈值=滞销；其余否", () => {
    expect(isSlowMover({ cover: null, onHand: 10, slowThreshold: 180 })).toBe(true);
    expect(isSlowMover({ cover: 200, onHand: 10, slowThreshold: 180 })).toBe(true);
    expect(isSlowMover({ cover: 100, onHand: 10, slowThreshold: 180 })).toBe(false);
    expect(isSlowMover({ cover: null, onHand: 0, slowThreshold: 180 })).toBe(false);
  });
});
