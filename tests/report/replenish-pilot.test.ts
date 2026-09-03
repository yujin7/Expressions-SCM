import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildSkuPlanningPolicy, overrideTier, setPilotFlags } from "@/server/modules/planning/policy";
import { computeReplenishPilot, loadReplenishPilot, PILOT_CACHE_KEY, pilotSourceBinding } from "@/server/modules/report/replenish-pilot";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/**
 * 试点读模型 replenish-pilot/v1：候选 = 生效分层 S/A/B ∧ XYZ=X ∧ 周期已维护 ∧ 无异动。
 * 阻塞维度可见（名单为什么短）；缓存键随策略/覆写/试点变化失效。
 */
describe("report/replenish-pilot", () => {
  let db: TestDb;
  let w: TierWorld;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("未固化：分层按实时值；候选只有 S（A/B 因周期缺失阻塞）；销量占比 60%", async () => {
    const m = await computeReplenishPilot(db);
    expect(m.period).toBeNull();
    expect(m.scanned).toBe(5);
    expect(m.candidates).toBe(1);
    expect(m.candidateSalesSharePct).toBe(60);
    expect(m.blockers).toEqual({ tierC: 2, xyzNotX: 0, xyzUnclassified: 0, leadMissing: 2, detectorHit: 0 });
    expect(m.byTier).toEqual({ S: { total: 1, eligible: 1 }, A: { total: 1, eligible: 0 }, B: { total: 1, eligible: 0 }, C: { total: 2, eligible: 0 } });
    const by = new Map(m.rows.map((r) => [r.skuId, r]));
    expect(by.get(w.sku.S)).toMatchObject({ eligible: true, tierSource: "live", blockers: [], ownership: "supply_chain_direct" });
    expect(by.get(w.sku.A)?.blockers).toEqual(["加工/在途周期未维护"]);
    expect(by.get(w.sku.B)?.blockers).toEqual(["加工/在途周期未维护"]); // 只维护了加工周期仍阻塞
    expect(by.get(w.sku.NEW)?.blockers).toEqual(["C 级长尾"]);
    expect(m.rows[0].skuId).toBe(w.sku.S); // 候选靠前
    expect(m.notes.some((n) => n.includes("尚未固化"))).toBe(true);
  });

  it("固化后：分层取策略期（含覆写）；缓存按 source_binding 命中、变化即重算", async () => {
    await buildSkuPlanningPolicy("2026-09", { db, actor: w.pmc });
    const first = await loadReplenishPilot(db);
    expect(first.period).toBe("2026-09");
    expect(first.sourceBinding).toBe(await pilotSourceBinding(db));
    const cached = await db.execute(sql`SELECT key, source_binding FROM report_read_model_cache WHERE key = ${PILOT_CACHE_KEY}`);
    const rows = (Array.isArray(cached) ? cached : (cached as { rows?: unknown[] }).rows ?? []) as { source_binding: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source_binding).toBe(first.sourceBinding);
    const again = await loadReplenishPilot(db);
    expect(again.builtAt).toBe(first.builtAt); // 命中缓存

    // 覆写 S→C：候选归零；binding 变化 → 不用旧值
    await overrideTier(w.pmc, { skuId: w.sku.S, period: "2026-09", overrideTier: "C", note: "试验" }, db);
    const afterOverride = await loadReplenishPilot(db);
    expect(afterOverride.sourceBinding).not.toBe(first.sourceBinding);
    expect(afterOverride.candidates).toBe(0);
    expect(afterOverride.rows.find((r) => r.skuId === w.sku.S)).toMatchObject({ tier: "C", tierSource: "policy_override", eligible: false });
    await overrideTier(w.pmc, { skuId: w.sku.S, period: "2026-09", overrideTier: null }, db);

    // 试点标记 → pilotMarked 与占比
    await setPilotFlags(w.pmc, { period: "2026-09", skuIds: [w.sku.S], pilot: true }, db);
    const withPilot = await loadReplenishPilot(db);
    expect(withPilot.candidates).toBe(1);
    expect(withPilot.pilotMarked).toBe(1);
    expect(withPilot.pilotSalesSharePct).toBe(60);
    expect(withPilot.rows.find((r) => r.skuId === w.sku.S)?.pilot).toBe(true);
    // refresh=1 强制重算亦一致
    const forced = await loadReplenishPilot(db, { refresh: true });
    expect(forced.candidates).toBe(1);
  });
});
