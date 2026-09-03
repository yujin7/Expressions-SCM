/**
 * D59 80/20 补货权责（纯函数，唯一权威）。
 *
 * - C 级 → ops_fallback（长尾由运营按需/停采评估）；
 * - S/A/B 且 XYZ=X 且无异动命中 且 交期主数据已知 → supply_chain_direct（供应链直出，主体角色 pmc）；
 * - 其余（Y/Z、异动命中、交期缺失、未分层/无波动数据）→ joint_review（供应链+运营联审）。
 * 本模块只给归属与理由，不改建议量。
 */
import type { Tier } from "@/server/rules/abc";
import type { XyzClass } from "@/server/rules/volatility";

export type Ownership = "supply_chain_direct" | "joint_review" | "ops_fallback";

export const OWNERSHIP_LABELS: Record<Ownership, string> = {
  supply_chain_direct: "供应链直出",
  joint_review: "联合评审",
  ops_fallback: "运营按需",
};

export interface OwnershipInput {
  /** 四级分层；null = 未分层（新品等） */
  tier: Tier | null;
  /** XYZ；null = 样本不足/无动销 */
  xyz: XyzClass | null;
  /** rules/detectors 等异动侦测是否命中 */
  detectorHit: boolean;
  /** sku_params 加工周期与在途周期均已维护 */
  leadDaysKnown: boolean;
}

export interface OwnershipResult {
  ownership: Ownership;
  reason: string;
}

export function decideOwnership(input: OwnershipInput): OwnershipResult {
  if (input.tier === "C") return { ownership: "ops_fallback", reason: "C 级长尾：运营按需/停采评估" };
  if (input.tier == null) return { ownership: "joint_review", reason: "未分层（新品或无销量窗口），先联审" };
  const blockers: string[] = [];
  if (input.xyz !== "X") blockers.push(input.xyz == null ? "波动样本不足" : `需求波动 ${input.xyz}`);
  if (input.detectorHit) blockers.push("异动侦测命中");
  if (!input.leadDaysKnown) blockers.push("交期主数据缺失");
  if (blockers.length === 0) {
    return { ownership: "supply_chain_direct", reason: `${input.tier} 级稳定品（X）、无异动、交期已知：供应链直出` };
  }
  return { ownership: "joint_review", reason: `${input.tier} 级但${blockers.join("、")}：联合评审` };
}
