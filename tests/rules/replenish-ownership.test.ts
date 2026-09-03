/** D59 80/20 补货权责（rules/replenish-ownership.ts） */
import { describe, expect, it } from "vitest";
import { decideOwnership } from "@/server/rules/replenish-ownership";

describe("decideOwnership", () => {
  it("S/A/B 且 X 且无异动且交期已知 → supply_chain_direct", () => {
    for (const tier of ["S", "A", "B"] as const) {
      expect(decideOwnership({ tier, xyz: "X", detectorHit: false, leadDaysKnown: true }).ownership).toBe("supply_chain_direct");
    }
  });
  it("C → ops_fallback（无论其他条件）", () => {
    expect(decideOwnership({ tier: "C", xyz: "X", detectorHit: false, leadDaysKnown: true }).ownership).toBe("ops_fallback");
    expect(decideOwnership({ tier: "C", xyz: null, detectorHit: true, leadDaysKnown: false }).ownership).toBe("ops_fallback");
  });
  it("Y/Z、异动命中、交期缺失、波动样本不足 → joint_review，理由逐项列出", () => {
    expect(decideOwnership({ tier: "A", xyz: "Y", detectorHit: false, leadDaysKnown: true })).toMatchObject({ ownership: "joint_review" });
    expect(decideOwnership({ tier: "S", xyz: "X", detectorHit: true, leadDaysKnown: true }).reason).toContain("异动侦测命中");
    expect(decideOwnership({ tier: "B", xyz: "X", detectorHit: false, leadDaysKnown: false }).reason).toContain("交期主数据缺失");
    const r = decideOwnership({ tier: "A", xyz: null, detectorHit: true, leadDaysKnown: false });
    expect(r.ownership).toBe("joint_review");
    expect(r.reason).toContain("波动样本不足");
    expect(r.reason).toContain("异动侦测命中");
    expect(r.reason).toContain("交期主数据缺失");
  });
  it("未分层（新品）→ joint_review", () => {
    expect(decideOwnership({ tier: null, xyz: "X", detectorHit: false, leadDaysKnown: true }).ownership).toBe("joint_review");
  });
});
