import { beforeAll, describe, expect, it } from "vitest";
import { buildSkuPlanningPolicy } from "@/server/modules/planning/policy";
import { getDataHealth } from "@/server/modules/report/data-health";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/**
 * 周期主数据完整度 × 分层（D58/D59，leadTimeCoverage 指标）：S/A/B 缺加工或在途周期即阻塞；
 * C / 未分层只计缺失不计阻塞；未固化时全部归「未分层」桶，不假装分层。
 */
describe("report/data-health：leadTimeCoverage", () => {
  let db: TestDb;
  let w: TierWorld;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("未固化：全部进 unclassified，阻塞为 0", async () => {
    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    const c = r.leadTimeCoverage;
    expect(c.policyPeriod).toBeNull();
    expect(c.scanned).toBe(5);
    expect(c.byTier.unclassified).toMatchObject({ total: 5, productionOk: 2, logisticsOk: 1, complete: 1, blocked: 0, completePct: 20 });
    expect(c.blocked).toBe(0);
    for (const k of ["S", "A", "B", "C"] as const) expect(c.byTier[k].total).toBe(0);
  });

  it("固化后：S 完整；A、B 阻塞；C 缺失不阻塞；样例按 S→A→B", async () => {
    await buildSkuPlanningPolicy("2026-09", { db, actor: w.pmc });
    const r = await getDataHealth({ page: 1, pageSize: 50 }, db);
    const c = r.leadTimeCoverage;
    expect(c.policyPeriod).toBe("2026-09");
    expect(c.byTier.S).toMatchObject({ total: 1, complete: 1, blocked: 0, completePct: 100 });
    expect(c.byTier.A).toMatchObject({ total: 1, productionOk: 0, logisticsOk: 0, complete: 0, blocked: 1, completePct: 0 });
    expect(c.byTier.B).toMatchObject({ total: 1, productionOk: 1, logisticsOk: 0, complete: 0, blocked: 1, completePct: 0 });
    expect(c.byTier.C).toMatchObject({ total: 2, complete: 0, blocked: 0 });
    expect(c.byTier.unclassified.total).toBe(0);
    expect(c.blocked).toBe(2);
    expect(c.blockedSamples).toEqual([
      "A 级 TIER-A 主力品 A（缺加工周期、在途周期）",
      "B 级 TIER-B 常规品 B（缺在途周期）",
    ]);
  });
});
