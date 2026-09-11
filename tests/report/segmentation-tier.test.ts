import { beforeAll, describe, expect, it } from "vitest";
import { sysParams } from "@/db/schema";
import { getSegmentation, loadTierCuts } from "@/server/modules/report/segmentation";
import { DEFAULT_TIER_CUTS, tierToAbc } from "@/server/rules/abc";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/**
 * 分层页 D58/D59 列：tier 走 rules/abc.classifyTier（参数化切点），与既有三档保持不变量 tierToAbc(tier)===abc；
 * ownership 走 rules/replenish-ownership（xyz 用规则层原值，null 不假装 Z）。
 */
describe("report/segmentation：四档与权责", () => {
  let db: TestDb;
  let w: TierWorld;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("四档按累计占比切分；abc 不变量；权责逐行；分布与权责汇总全量", async () => {
    const r = await getSegmentation({ allRows: true }, db);
    expect(r.tierCuts).toEqual(DEFAULT_TIER_CUTS);
    expect(r.total).toBe(5);
    const by = new Map(r.rows.map((x) => [x.skuId, x]));
    expect(by.get(w.sku.S)).toMatchObject({ tier: "S", abc: "A", xyz: "X", xyzRaw: "X", ownership: "supply_chain_direct", leadDaysKnown: true, detectorHit: false });
    expect(by.get(w.sku.A)).toMatchObject({ tier: "A", abc: "A", ownership: "joint_review", leadDaysKnown: false });
    expect(by.get(w.sku.A)?.ownershipReason).toContain("交期主数据缺失");
    expect(by.get(w.sku.B)).toMatchObject({ tier: "B", abc: "B", ownership: "joint_review", leadDaysKnown: false });
    expect(by.get(w.sku.C)).toMatchObject({ tier: "C", abc: "C", ownership: "ops_fallback" });
    expect(by.get(w.sku.NEW)).toMatchObject({ tier: "C", xyz: "Z", xyzRaw: null, ownership: "ops_fallback" });
    for (const row of r.rows) expect(tierToAbc(row.tier), row.code).toBe(row.abc);
    expect(r.xyzUnclassified).toBe(1);
    expect(r.tierDistribution.S).toEqual({ count: 1, value: 3600, valueSharePct: 60 });
    expect(r.tierDistribution.C.count).toBe(2);
    expect(r.ownershipMix).toEqual({ supply_chain_direct: 1, joint_review: 2, ops_fallback: 2 });
  });

  it("筛选 tier / ownership 只裁行，不改全量汇总", async () => {
    const t = await getSegmentation({ tier: "c" }, db);
    expect(t.total).toBe(2);
    expect(t.ownershipMix.joint_review).toBe(2);
    const o = await getSegmentation({ ownership: "supply_chain_direct" }, db);
    expect(o.rows.map((x) => x.code)).toEqual(["TIER-S"]);
  });

  it("切点参数化：sys_params grade_* 生效；非递增时回落缺省", async () => {
    await db.insert(sysParams).values([
      { scope: "global", key: "grade_s_pct", value: "70" },
      { scope: "global", key: "grade_a_pct", value: "90" },
      { scope: "global", key: "grade_b_pct", value: "97" },
    ]);
    expect(await loadTierCuts(db)).toEqual({ sPct: 70, aPct: 90, bPct: 97 });
    const r = await getSegmentation({ allRows: true }, db);
    const by = new Map(r.rows.map((x) => [x.skuId, x]));
    expect(by.get(w.sku.A)?.tier).toBe("S"); // 前 60% < 70 → S
    expect(by.get(w.sku.B)?.tier).toBe("A"); // 前 85% < 90 → A
    expect(by.get(w.sku.C)?.tier).toBe("B"); // 前 95% < 97 → B
    // 既有三档 abc 仍按标准帕累托 80/95（既有消费者不受切点参数影响）；不变量只在缺省切点成立
    expect(by.get(w.sku.B)?.abc).toBe("B");
    expect(by.get(w.sku.C)?.abc).toBe("C");

    await db.insert(sysParams).values({ scope: "global", key: "grade_s_pct", value: "95" }).onConflictDoUpdate({ target: [sysParams.scope, sysParams.key], set: { value: "95" } });
    expect(await loadTierCuts(db)).toEqual(DEFAULT_TIER_CUTS);
  });
});
