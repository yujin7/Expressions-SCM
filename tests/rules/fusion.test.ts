/** R11+ 全口径供需融合纯规则测试（rules/fusion.ts） */
import { describe, expect, it } from "vitest";
import { belowLeadtime, detectRefGap, fuseCover, shouldSuppressSuggest } from "@/server/rules/fusion";

describe("detectRefGap（覆盖缺口判定）", () => {
  it("参考显著高于系统（绝对>10 且相对>20%）→ 缺口", () => {
    expect(detectRefGap(0, 176216)).toBe(true); // E054-000 实况
    expect(detectRefGap(3381, 44168)).toBe(true); // E01-001-a 实况
  });
  it("差异小（绝对≤10 或 相对≤20%）→ 非缺口", () => {
    expect(detectRefGap(100, 108)).toBe(false); // 绝对差 8 ≤ 10
    expect(detectRefGap(1000, 1100)).toBe(false); // 相对差 10% ≤ 20%
    expect(detectRefGap(500, 400)).toBe(false); // 参考更低：绝不判缺口
    expect(detectRefGap(500, null)).toBe(false); // 无参考
  });
});

describe("fuseCover（全管道可销天数）", () => {
  it("有效在库=max(系统,参考)，加总各类在途后除以日均", () => {
    // 系统 0 / 参考 900 / PO在途 50 / 存量在途 30 / 在订 20 / 日均 10 → (900+100)/10=100
    expect(fuseCover({ onHand: 0, refQty: 900, inTransit: 50, legacyTransit: 30, onOrder: 20, daily: 10 })).toBe(100);
  });
  it("参考低于系统时以系统为准（参考只调高不调低）", () => {
    expect(fuseCover({ onHand: 500, refQty: 100, inTransit: 0, legacyTransit: 0, onOrder: 0, daily: 10 })).toBe(50);
  });
  it("日均=0 → null（与既有可销天数口径一致）", () => {
    expect(fuseCover({ onHand: 100, refQty: null, inTransit: 0, legacyTransit: 0, onOrder: 0, daily: 0 })).toBeNull();
  });
});

describe("shouldSuppressSuggest（防重复下单抑制）", () => {
  it("缺口 SKU：系统告急但全管道充足 → 抑制", () => {
    expect(shouldSuppressSuggest(5, 60, 30, true)).toBe(true);
  });
  it("非缺口 SKU 永不抑制（全管道再高也走正常建议）", () => {
    expect(shouldSuppressSuggest(5, 60, 30, false)).toBe(false);
  });
  it("全管道同样告急 → 不抑制（真缺货，照常建议）", () => {
    expect(shouldSuppressSuggest(5, 20, 30, true)).toBe(false);
  });
  it("无动销（cover=null）→ 不抑制", () => {
    expect(shouldSuppressSuggest(null, 60, 30, true)).toBe(false);
  });
});

describe("belowLeadtime（生产周期风险）", () => {
  it("可销天数 < 常规生产周期 → 风险", () => {
    expect(belowLeadtime(20, 35)).toBe(true);
    expect(belowLeadtime(40, 35)).toBe(false);
  });
  it("缺参数 → 不标注", () => {
    expect(belowLeadtime(null, 35)).toBe(false);
    expect(belowLeadtime(20, null)).toBe(false);
    expect(belowLeadtime(20, 0)).toBe(false);
  });
});
