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
  it("有效在库=max(系统,参考)，加总在途后除以日均（存量在途与在订取 max，不相加）", () => {
    // 系统 0 / 参考 900 / PO在途 50 / 存量在途 30 / 在订 20 / 日均 10
    // → (900 + 50 + max(30,20)) / 10 = 98
    // 口径变更（2026-07-25）：原断言为 100，把 legacyTransit 与 onOrder 相加。
    // core/supply.ts:22-25 写明二者可能指向同一批货、故在那里是 default-off；
    // 相加等于绕过该闸门，实测全库重复计入 1,293,972 件。此处按修正后口径。
    expect(fuseCover({ onHand: 0, refQty: 900, inTransit: 50, legacyTransit: 30, onOrder: 20, daily: 10 })).toBe(98);
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

/**
 * 2026-07-25 审计修正：legacyTransit 与 onOrder 不得相加。
 * core/supply.ts:22-25 写明 on_order 与 po/legacy_fg 可能指向同一批货，
 * 故在 core/supply 是 default-off；fuseCover 原先无条件相加绕过了该闸门，
 * 实测重复计入 1,293,972 件（151/152 个 SKU 两者并存）。
 */
describe("fuseCover：存量单在途与在订未出不重复计入", () => {
  const base = { onHand: 0, refQty: null, inTransit: 0, daily: 10 };

  it("两者并存时取较大者，不相加", () => {
    const both = fuseCover({ ...base, legacyTransit: 500, onOrder: 300 });
    const onlyLegacy = fuseCover({ ...base, legacyTransit: 500, onOrder: 0 });
    expect(both).toBe(onlyLegacy); // 50 天，不是 80 天
    expect(both).toBe(50);
  });

  it("onOrder 更大时以 onOrder 为准（参考只调高认知）", () => {
    expect(fuseCover({ ...base, legacyTransit: 100, onOrder: 900 })).toBe(90);
  });

  it("只有一侧有值时行为不变", () => {
    expect(fuseCover({ ...base, legacyTransit: 0, onOrder: 400 })).toBe(40);
    expect(fuseCover({ ...base, legacyTransit: 400, onOrder: 0 })).toBe(40);
  });
});
