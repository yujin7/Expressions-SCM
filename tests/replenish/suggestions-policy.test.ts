import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildSkuPlanningPolicy } from "@/server/modules/planning/policy";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import { getSegmentation } from "@/server/modules/report/segmentation";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/**
 * 补货建议的 D58/D59 消费行为：tier / ownership / pilot 只读 sku_planning_policy 最近固化期，不重算；
 * 未固化 → 三列 null 且 meta.policyPeriod=null；hideTierC 折叠 C 并计数；tier=none / ownership 筛选。
 * 异动侦测命中（planning/detector-hits 唯一入口，此处 mock）→ 分层页权责=联合评审、理由含「异动侦测命中」，
 * 重新固化后建议行同步。
 */
const detector = vi.hoisted(() => ({ hits: new Set<number>() }));
vi.mock("@/server/modules/planning/detector-hits", () => ({
  loadDetectorHitSkuIds: async () => new Set(detector.hits),
}));

describe("replenish/service：分层/权责消费（固化策略 + 折叠 + 筛选 + 异动命中）", () => {
  let db: TestDb;
  let w: TierWorld;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("未固化：tier/ownership=null、meta.policyPeriod=null；tier=none 取全部；hideTierC 无可折叠", async () => {
    const r = await getReplenishSuggestions({}, db);
    expect(r.meta.policyPeriod).toBeNull();
    expect(r.total).toBe(5);
    expect(r.rows.every((x) => x.tier === null && x.ownership === null && x.ownershipLabel === null && x.pilot === false && x.tierOverridden === false)).toBe(true);
    expect(r.meta.ownershipMix).toEqual({ supply_chain_direct: 0, joint_review: 0, ops_fallback: 0 });
    expect((await getReplenishSuggestions({ tier: "none" }, db)).total).toBe(5);
    expect((await getReplenishSuggestions({ tier: "S" }, db)).total).toBe(0);
    const hidden = await getReplenishSuggestions({ hideTierC: true }, db);
    expect(hidden.total).toBe(5);
    expect(hidden.meta.hiddenTierC).toBe(0);
  });

  it("固化后：hideTierC 折叠 C 并计数；tier=none 为 0；ownership 筛选；显式 tier 筛选优先于折叠", async () => {
    await buildSkuPlanningPolicy("2026-09", { db, actor: w.pmc });
    const r = await getReplenishSuggestions({ hideTierC: true }, db);
    expect(r.meta.policyPeriod).toBe("2026-09");
    expect(r.total).toBe(3);
    expect(r.meta.hiddenTierC).toBe(2);
    expect(r.rows.map((x) => x.code).sort()).toEqual(["TIER-A", "TIER-B", "TIER-S"]);
    // 全量权责分布不受折叠/筛选影响
    expect(r.meta.ownershipMix).toEqual({ supply_chain_direct: 1, joint_review: 2, ops_fallback: 2 });

    expect((await getReplenishSuggestions({ tier: "none" }, db)).total).toBe(0);
    const direct = await getReplenishSuggestions({ ownership: "supply_chain_direct" }, db);
    expect(direct.rows.map((x) => x.code)).toEqual(["TIER-S"]);
    expect(direct.rows[0]).toMatchObject({ tier: "S", ownership: "supply_chain_direct", ownershipLabel: "供应链直出", tierOverridden: false, pilot: false });
    const joint = await getReplenishSuggestions({ ownership: "joint_review" }, db);
    expect(joint.rows.map((x) => x.code).sort()).toEqual(["TIER-A", "TIER-B"]);

    const c = await getReplenishSuggestions({ tier: "C", hideTierC: true }, db);
    expect(c.total).toBe(2);
    expect(c.meta.hiddenTierC).toBe(0); // 显式看 C 时不折叠
    const fallback = await getReplenishSuggestions({ ownership: "ops_fallback", hideTierC: true }, db);
    expect(fallback.total).toBe(0);
    expect(fallback.meta.hiddenTierC).toBe(2);
  });

  it("异动侦测命中：S 级稳定品命中 → 权责=联合评审、理由含「异动侦测命中」；重新固化后建议行同步", async () => {
    detector.hits.add(w.sku.S);
    const seg = await getSegmentation({ allRows: true }, db);
    const s = seg.rows.find((x) => x.skuId === w.sku.S)!;
    expect(s).toMatchObject({ tier: "S", xyzRaw: "X", leadDaysKnown: true, detectorHit: true, ownership: "joint_review" });
    expect(s.ownershipReason).toContain("异动侦测命中");
    expect(seg.ownershipMix).toEqual({ supply_chain_direct: 0, joint_review: 3, ops_fallback: 2 });

    // 未重新固化：建议行仍按已固化值（不在读路径重算）
    expect((await getReplenishSuggestions({ ownership: "supply_chain_direct" }, db)).rows.map((x) => x.code)).toEqual(["TIER-S"]);

    // 本期已固化 → 必须显式 force 才重算（默认幂等跳过，见 planning/policy 幂等闸）
    expect((await buildSkuPlanningPolicy("2026-09", { db, actor: w.pmc })).skipped).toBe(true);
    const build = await buildSkuPlanningPolicy("2026-09", { db, actor: w.pmc, force: true });
    expect(build.skipped).toBe(false);
    expect(build.byOwnership).toEqual({ supply_chain_direct: 0, joint_review: 3, ops_fallback: 2 });
    expect(build.blockers).toEqual({ leadDaysUnknown: 2, xyzNull: 0, xyzNotX: 0, detectorHit: 1, candidates: 3 });

    const after = await getReplenishSuggestions({}, db);
    expect(after.rows.find((x) => x.skuId === w.sku.S)).toMatchObject({ tier: "S", ownership: "joint_review", ownershipLabel: "联合评审" });
    expect((await getReplenishSuggestions({ ownership: "supply_chain_direct" }, db)).total).toBe(0);
    expect(after.meta.ownershipMix).toEqual({ supply_chain_direct: 0, joint_review: 3, ops_fallback: 2 });
  });
});
