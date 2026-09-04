/**
 * W12 金额口径并列分层（report/segmentation 的 valueTier 列 + replenish-pilot/v2 迁移矩阵）。
 *
 * 钉住的口径：
 *   - `tier`（数量口径）在任何情况下都不变——本次只并列对照，不 repoint 任何消费者；
 *   - `tier_basis` 开关只改「声明口径」，`tierBasisApplied` 恒 qty；
 *   - 成本覆盖率（按销量加权）低于 valuation_coverage_min_pct 时，金额列一律 insufficient（null），
 *     绝不降级成 C；
 *   - 覆盖率达标时金额口径能给出与数量口径不同的答案（贵的战略品上移）。
 */
import { describe, expect, it } from "vitest";
import { skuCosts, sysParams } from "@/db/schema";
import { clearParamCache } from "@/server/core/params";
import { getSegmentation, loadTierBasis } from "@/server/modules/report/segmentation";
import { computeReplenishPilot, PILOT_CACHE_KEY } from "@/server/modules/report/replenish-pilot";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/** 覆盖率不足场景：只给销量最小的 C 级品成本（销量加权覆盖率 5%） */
async function costOnlyForC(db: TestDb, w: TierWorld): Promise<void> {
  await db.insert(skuCosts).values({ skuId: w.sku.C, unitCost: "10.0000" });
}

describe("W12 金额口径并列分层", () => {
  it("无任何成本 → 金额列全部 insufficient，数量口径分层一字不变", async () => {
    const { db, client } = await createTestDb();
    try {
      clearParamCache();
      const w = await seedTierWorld(db);
      const r = await getSegmentation({ allRows: true }, db);
      expect(r.costCoverage.state).toBe("insufficient");
      expect(r.costCoverage.salesWeightedPct).toBe(0);
      expect(r.costCoverage.minPct).toBe(80);
      expect(r.costCoverage.reason).toContain("门槛 80%");
      const by = new Map(r.rows.map((x) => [x.skuId, x]));
      // 数量口径与 D58 基线完全一致
      expect(by.get(w.sku.S)?.tier).toBe("S");
      expect(by.get(w.sku.A)?.tier).toBe("A");
      expect(by.get(w.sku.C)?.tier).toBe("C");
      // 金额列一律不可用，且**不是 C**
      for (const row of r.rows) expect(row.valueTier).toBeNull();
      expect(r.valueTierDistribution).toEqual({ S: { count: 0 }, A: { count: 0 }, B: { count: 0 }, C: { count: 0 } });
      expect(r.tierMigration.insufficient).toBe(5);
      expect(r.tierMigration.agree).toBe(0);
      expect(r.tierMigration.agreePct).toBeNull();
      expect(r.tierBasis).toBe("qty");
      expect(r.tierBasisApplied).toBe("qty");
    } finally {
      await client.close();
    }
  });

  it("覆盖率低于门槛（只有长尾品有成本）→ 仍是 insufficient，不因「有几个成本」就开列", async () => {
    const { db, client } = await createTestDb();
    try {
      clearParamCache();
      const w = await seedTierWorld(db);
      await costOnlyForC(db, w);
      const r = await getSegmentation({ allRows: true }, db);
      // 有成本 SKU 1/5，但按销量加权只有 5%
      expect(r.costCoverage.skusWithCost).toBe(1);
      expect(r.costCoverage.skuPct).toBe(20);
      expect(r.costCoverage.salesWeightedPct).toBe(5);
      expect(r.costCoverage.state).toBe("insufficient");
      expect(r.rows.every((x) => x.valueTier === null)).toBe(true);
      // 有成本的那一行也不许提前开列——覆盖率是整表口径的前提
      expect(r.rows.find((x) => x.skuId === w.sku.C)?.unitCostSource).toBe("sku_costs");
      expect(r.rows.find((x) => x.skuId === w.sku.C)?.valueTier).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("覆盖率达标 → 金额口径给出不同答案；数量口径与既有消费者不受影响", async () => {
    const { db, client } = await createTestDb();
    try {
      clearParamCache();
      const w = await seedTierWorld(db);
      /*
       * 近 6 月销量：S 3600 / A 1500 / B 600 / C 300 / NEW 0（合计 6000）。
       * 单位成本：S 1 / A 20 / B 5 / C 1 → 金额 3600 / 30000 / 3000 / 300（合计 36900）。
       * 金额口径排序：A(30000, prev 0% → S) · S(3600, prev 81.3% → B) · B(3000, prev 91% → B) · C(300 → C)。
       * 也就是件数第一的 S 在金额口径下掉到 B，而 A 上到 S——这正是 W12 要让人看见的迁移。
       */
      await db.insert(skuCosts).values([
        { skuId: w.sku.S, unitCost: "1.0000" },
        { skuId: w.sku.A, unitCost: "20.0000" },
        { skuId: w.sku.B, unitCost: "5.0000" },
        { skuId: w.sku.C, unitCost: "1.0000" },
      ]);
      const r = await getSegmentation({ allRows: true }, db);
      expect(r.costCoverage.state).toBe("ready");
      expect(r.costCoverage.salesWeightedPct).toBe(100);
      const by = new Map(r.rows.map((x) => [x.skuId, x]));
      // 数量口径一字不变
      expect(by.get(w.sku.S)?.tier).toBe("S");
      expect(by.get(w.sku.A)?.tier).toBe("A");
      // 金额口径给出另一套答案
      expect(by.get(w.sku.A)?.valueTier).toBe("S");
      expect(by.get(w.sku.S)?.valueTier).toBe("B");
      // 无销量的新品在两套口径下都恒 C；无成本 → 该行金额列仍是 null
      expect(by.get(w.sku.NEW)?.tier).toBe("C");
      expect(by.get(w.sku.NEW)?.valueTier).toBeNull();
      expect(by.get(w.sku.NEW)?.unitCostSource).toBeNull();
      // 权责仍由数量口径驱动（未 repoint）
      expect(by.get(w.sku.S)?.ownership).toBe("supply_chain_direct");
      expect(r.tierMigration.disagree).toBeGreaterThan(0);
      expect(r.tierMigration.insufficient).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("tier_basis 开关：非法值回落 qty；设为 value 也只改声明口径，tier 与消费者不动", async () => {
    const { db, client } = await createTestDb();
    try {
      clearParamCache();
      const w = await seedTierWorld(db);
      await db.insert(skuCosts).values([
        { skuId: w.sku.S, unitCost: "1.0000" },
        { skuId: w.sku.A, unitCost: "20.0000" },
        { skuId: w.sku.B, unitCost: "5.0000" },
        { skuId: w.sku.C, unitCost: "1.0000" },
      ]);
      expect(await loadTierBasis(db)).toBe("qty"); // 未设置 = 缺省

      await db.insert(sysParams).values({ scope: "global", key: "tier_basis", value: "金额" });
      expect(await loadTierBasis(db)).toBe("qty"); // 非法值回落，不让脏值改口径

      await db.update(sysParams).set({ value: "value" });
      expect(await loadTierBasis(db)).toBe("value");
      const r = await getSegmentation({ allRows: true }, db);
      expect(r.tierBasis).toBe("value");
      expect(r.tierBasisApplied).toBe("qty");
      const by = new Map(r.rows.map((x) => [x.skuId, x]));
      expect(by.get(w.sku.S)?.tier).toBe("S"); // 开关没有改变 tier
      expect(by.get(w.sku.A)?.valueTier).toBe("S");
    } finally {
      await client.close();
    }
  });

  it("试点读模型 v2 携带金额列与迁移矩阵，候选判定仍只读数量口径", async () => {
    const { db, client } = await createTestDb();
    try {
      clearParamCache();
      const w = await seedTierWorld(db);
      await db.insert(skuCosts).values([
        { skuId: w.sku.S, unitCost: "1.0000" },
        { skuId: w.sku.A, unitCost: "20.0000" },
        { skuId: w.sku.B, unitCost: "5.0000" },
        { skuId: w.sku.C, unitCost: "1.0000" },
      ]);
      const model = await computeReplenishPilot(db);
      expect(PILOT_CACHE_KEY).toBe("replenish-pilot/v2");
      expect(model.tierBasisApplied).toBe("qty");
      expect(model.costCoverage.state).toBe("ready");
      expect(model.tierMigration.total).toBe(model.rows.length);
      const s = model.rows.find((r) => r.skuId === w.sku.S)!;
      expect(s.tier).toBe("S");
      expect(s.valueTier).toBe("B");
      // 候选 = S/A/B ∧ XYZ=X ∧ 周期已维护 ∧ 无异动：金额口径没有改变任何一项
      expect(s.eligible).toBe(true);
      const a = model.rows.find((r) => r.skuId === w.sku.A)!;
      expect(a.valueTier).toBe("S");
      expect(a.eligible).toBe(false); // 仍因交期主数据缺失被阻塞
      expect(model.valueTierLimitations.some((n) => n.includes("不 repoint 任何消费者"))).toBe(true);
    } finally {
      await client.close();
    }
  });
});
