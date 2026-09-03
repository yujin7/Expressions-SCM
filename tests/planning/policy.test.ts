import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLogs, skuPlanningPolicy } from "@/db/schema";
import {
  assertPeriod, buildSkuPlanningPolicy, currentPeriod, getPolicy, loadPolicyMap, overrideTier, runPolicyBuild, setPilotFlags, tierShare,
} from "@/server/modules/planning/policy";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/**
 * D58/D59 月度固化：分层/权责来自 report/segmentation（唯一权威链 rules/abc → volatility → replenish-ownership），
 * 本模块只负责「固化 + 覆写留痕 + 试点标记」。护栏：
 * - 固化写 sku_planning_policy 且同事务审计；
 * - 覆写只改 override_*，规则 tier 保留；重建不抹覆写；
 * - 写守卫 pmc（admin 兜底），purchasing 403；覆写必须带理由。
 */
describe("planning/policy：分层固化、覆写、试点", () => {
  let db: TestDb;
  let w: TierWorld;
  const PERIOD = "2026-09";

  beforeAll(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("期间格式护栏", () => {
    expect(() => assertPeriod("2026-13")).toThrow();
    expect(() => assertPeriod("202609")).toThrow();
    expect(assertPeriod("2026-09")).toBe("2026-09");
    expect(currentPeriod()).toMatch(/^\d{4}-\d{2}$/);
  });

  it("固化：四档 S/A/B/C 与权责按唯一权威落库，同事务审计", async () => {
    const r = await buildSkuPlanningPolicy(PERIOD, { db, actor: w.pmc });
    expect(r.total).toBe(5);
    expect(r.inserted).toBe(5);
    expect(r.byTier).toEqual({ S: 1, A: 1, B: 1, C: 2 });
    expect(r.byOwnership).toEqual({ supply_chain_direct: 1, joint_review: 2, ops_fallback: 2 });

    const rows = await db.select().from(skuPlanningPolicy).where(eq(skuPlanningPolicy.period, PERIOD));
    const by = new Map(rows.map((x) => [x.skuId, x]));
    expect(by.get(w.sku.S)).toMatchObject({ tier: "S", abc: "A", xyz: "X", ownership: "supply_chain_direct", pilot: false, overrideTier: null });
    expect(by.get(w.sku.A)).toMatchObject({ tier: "A", abc: "A", xyz: "X", ownership: "joint_review" });
    expect(by.get(w.sku.B)).toMatchObject({ tier: "B", abc: "B", xyz: "X", ownership: "joint_review" });
    expect(by.get(w.sku.C)).toMatchObject({ tier: "C", abc: "C", ownership: "ops_fallback" });
    // 无销量：恒 C，XYZ 样本不足 → null（不假装 Z）
    expect(by.get(w.sku.NEW)).toMatchObject({ tier: "C", abc: "C", xyz: null, ownership: "ops_fallback" });

    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "sku_planning_policy"), eq(auditLogs.action, "build")));
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(w.pmc.id);
    expect((audits[0].after as { period: string; source: string }).period).toBe(PERIOD);
    expect((audits[0].after as { source: string }).source).toBe("manual");
  });

  it("loadPolicyMap：缺省取最近期；未固化期返回空", async () => {
    const m = await loadPolicyMap(db);
    expect(m.period).toBe(PERIOD);
    expect(m.bySku.get(w.sku.S)).toMatchObject({ tier: "S", effectiveTier: "S", ownership: "supply_chain_direct" });
    const none = await loadPolicyMap(db, "2025-01");
    expect(none.period).toBe("2025-01");
    expect(none.bySku.size).toBe(0);
  });

  it("覆写：必须带理由；purchasing 403；pmc 覆写只改 override_*，规则 tier 保留", async () => {
    await expect(overrideTier(w.pmc, { skuId: w.sku.S, period: PERIOD, overrideTier: "A" }, db)).rejects.toMatchObject({ status: 400 });
    await expect(overrideTier(w.purchasing, { skuId: w.sku.S, period: PERIOD, overrideTier: "A", note: "x" }, db)).rejects.toMatchObject({ status: 403 });
    await expect(overrideTier(w.pmc, { skuId: w.sku.S, period: "2025-01", overrideTier: "A", note: "x" }, db)).rejects.toMatchObject({ status: 404 });

    const r = await overrideTier(w.pmc, { skuId: w.sku.S, period: PERIOD, overrideTier: "A", note: "季节性下调" }, db);
    expect(r).toMatchObject({ tier: "S", overrideTier: "A", effectiveTier: "A" });
    const [row] = await db.select().from(skuPlanningPolicy).where(and(eq(skuPlanningPolicy.skuId, w.sku.S), eq(skuPlanningPolicy.period, PERIOD)));
    expect(row.tier).toBe("S");
    expect(row.overrideTier).toBe("A");
    expect(row.overrideBy).toBe(w.pmc.id);
    expect(row.overrideNote).toBe("季节性下调");
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "override_tier"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(row.id);

    // 覆写成与规则分层相同的值 = 撤销覆写
    const back = await overrideTier(w.pmc, { skuId: w.sku.S, period: PERIOD, overrideTier: "S", note: "恢复" }, db);
    expect(back.overrideTier).toBeNull();
    await overrideTier(w.pmc, { skuId: w.sku.S, period: PERIOD, overrideTier: "A", note: "再次下调" }, db);
  });

  it("重建同期：覆写与试点保留（overridesKept），审计再记一行", async () => {
    await setPilotFlags(w.pmc, { period: PERIOD, skuIds: [w.sku.B], pilot: true }, db);
    const r = await buildSkuPlanningPolicy(PERIOD, { db, actor: w.pmc });
    expect(r.inserted).toBe(0);
    expect(r.updated).toBe(5);
    expect(r.overridesKept).toBe(1);
    const rows = await db.select().from(skuPlanningPolicy).where(eq(skuPlanningPolicy.period, PERIOD));
    const by = new Map(rows.map((x) => [x.skuId, x]));
    expect(by.get(w.sku.S)).toMatchObject({ tier: "S", overrideTier: "A" });
    expect(by.get(w.sku.B)?.pilot).toBe(true);
    const m = await loadPolicyMap(db, PERIOD);
    expect(m.bySku.get(w.sku.S)?.effectiveTier).toBe("A");
  });

  it("试点标记：pmc 可批量；未固化的 SKU 记 missing；purchasing 403", async () => {
    const r = await setPilotFlags(w.pmc, { period: PERIOD, skuIds: [w.sku.S, 999999], pilot: true }, db);
    expect(r.changed).toBe(1);
    expect(r.missing).toEqual([999999]);
    await expect(setPilotFlags(w.purchasing, { period: PERIOD, skuIds: [w.sku.S], pilot: false }, db)).rejects.toMatchObject({ status: 403 });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "pilot_add"));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("getPolicy：汇总用生效分层；筛选 overriddenOnly / pilotOnly / tier", async () => {
    const all = await getPolicy({ period: PERIOD }, db);
    expect(all.total).toBe(5);
    expect(all.summary.byTier).toEqual({ S: 1, A: 1, B: 1, C: 2 });
    expect(all.summary.byEffectiveTier).toEqual({ S: 0, A: 2, B: 1, C: 2 });
    expect(all.summary.overrides).toBe(1);
    expect(all.summary.pilot).toBe(2);
    expect(all.rows[0].effectiveTier).toBe("A"); // S→A 排序按生效分层
    const ov = await getPolicy({ period: PERIOD, overriddenOnly: true }, db);
    expect(ov.rows.map((r) => r.skuId)).toEqual([w.sku.S]);
    const pil = await getPolicy({ period: PERIOD, pilotOnly: true }, db);
    expect(new Set(pil.rows.map((r) => r.skuId))).toEqual(new Set([w.sku.S, w.sku.B]));
    const tierA = await getPolicy({ period: PERIOD, tier: "A" }, db);
    expect(tierA.total).toBe(2);
    expect(tierShare(all.summary.byTier)).toEqual({ S: { count: 1, pct: 20 }, A: { count: 1, pct: 20 }, B: { count: 1, pct: 20 }, C: { count: 2, pct: 40 } });
  });

  it("runPolicyBuild（调度入口）：固化当月，审计 source=scheduler、userId 取系统 admin", async () => {
    const r = await runPolicyBuild(db);
    expect(r.period).toBe(currentPeriod());
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "sku_planning_policy"), eq(auditLogs.action, "build")));
    const sched = audits.find((a) => (a.after as { source?: string }).source === "scheduler");
    expect(sched).toBeDefined();
    expect(sched!.userId).toBe(w.admin.id);
  });

  it("写守卫：purchasing 不能固化", async () => {
    await expect(buildSkuPlanningPolicy("2026-10", { db, actor: w.purchasing })).rejects.toMatchObject({ status: 403 });
  });
});
