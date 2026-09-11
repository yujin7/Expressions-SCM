/**
 * D51 库存金额估值唯一权威（core/valuation.ts）——PGlite 造数：
 * sku_costs 优先于财务观察；财务观察取最新成功批次、同码取 useMonth 最新且 operatingCost 数值非空；
 * superseded 批次不用；无成本 SKU → null 并计入未覆盖。
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { resolveUnitCosts, valueOnHand } from "@/server/core/valuation";
import { createTestDb, type TestDb } from "../helpers/db";

describe("valuation", () => {
  let db: TestDb;
  let manual = 0;      // sku_costs 有值且财务也有 → sku_costs 优先
  let finance = 0;     // 仅财务观察（两个月份，取最新；非数值行忽略）
  let stale = 0;       // 仅存在于被 supersede 的旧批次 → 不用
  let none = 0;        // 两者皆无

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [actor] = await db.insert(schema.users).values({ name: "估值测试", roles: ["finance"] }).returning();
    const [spu] = await db.insert(schema.spus).values({ code: "P90003", nameCn: "估值" }).returning();
    const mk = async (code: string) => {
      const [row] = await db.insert(schema.skus).values({ code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
      return row.id;
    };
    manual = await mk("VAL-MANUAL");
    finance = await mk("VAL-FIN");
    stale = await mk("VAL-STALE");
    none = await mk("VAL-NONE");
    await db.insert(schema.skuCosts).values({ skuId: manual, unitCost: "12.3456", updatedBy: actor.id });

    const [oldJob, newJob] = await db.insert(schema.importJobs).values([
      { template: "jdy_finance_operating_cost_observation", filename: "old", createdBy: actor.id, status: "superseded" },
      { template: "jdy_finance_operating_cost_observation", filename: "new", createdBy: actor.id, status: "done" },
    ]).returning();
    await db.insert(schema.integrationRuns).values([
      { connector: "jdy", stream: "finance-operating-cost-observation", idempotencyKey: "fin-old", status: "succeeded", importJobId: oldJob.id,
        startedAt: new Date("2026-09-02T00:00:00.000Z"), finishedAt: new Date("2026-09-02T00:01:00.000Z") },
      { connector: "jdy", stream: "finance-operating-cost-observation", idempotencyKey: "fin-new", status: "succeeded", importJobId: newJob.id,
        startedAt: new Date("2026-09-01T00:00:00.000Z"), finishedAt: new Date("2026-09-01T00:01:00.000Z"), requestScope: { qualityBlocked: true } },
    ]);
    const row = (jobId: number, rowNo: number, data: Record<string, string>) => ({
      importJobId: jobId, rowNo, status: "pending" as const, targetTable: "jdy_finance_operating_cost_observation", payload: { data },
    });
    await db.insert(schema.stagingRows).values([
      // 旧批次（superseded）：即使 started_at 更晚也不能用
      row(oldJob.id, 1, { productCode: "VAL-STALE", useMonth: "2026-08", operatingCost: "1.00", usage: "常规" }),
      row(oldJob.id, 2, { productCode: "VAL-FIN", useMonth: "2026-09", operatingCost: "999.00", usage: "常规" }),
      // 新批次：VAL-FIN 两个月份取最新；VAL-MANUAL 也有观察值但应被 sku_costs 覆盖；非数值行忽略
      row(newJob.id, 1, { productCode: "VAL-FIN", useMonth: "2026-07", operatingCost: "8.5000", usage: "常规" }),
      row(newJob.id, 2, { productCode: "VAL-FIN", useMonth: "2026-08", operatingCost: "9.25", usage: "常规" }),
      row(newJob.id, 3, { productCode: "VAL-FIN", useMonth: "2026-09", operatingCost: "", usage: "常规" }),
      row(newJob.id, 4, { productCode: "VAL-MANUAL", useMonth: "2026-08", operatingCost: "1.00", usage: "常规" }),
    ]);
  });

  it("resolveUnitCosts：sku_costs 优先；财务观察取最新可用批次的最新月份；superseded 不用；皆无 → null", async () => {
    const m = await resolveUnitCosts(db, [manual, finance, stale, none, none]);
    expect(m.size).toBe(4);
    expect(m.get(manual)).toMatchObject({ unitCost: "12.3456", source: "sku_costs" });
    expect(m.get(manual)?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.get(finance)).toEqual({ unitCost: "9.2500", source: "finance_observation", asOf: "2026-08" });
    expect(m.get(stale)).toEqual({ unitCost: null, source: null, asOf: null });
    expect(m.get(none)).toEqual({ unitCost: null, source: null, asOf: null });
    expect((await resolveUnitCosts(db, [])).size).toBe(0);
  });

  it("valueOnHand：金额 Σqty×成本（scale 2）、覆盖率按数量、按来源分桶、未覆盖 SKU 清单", async () => {
    const costs = await resolveUnitCosts(db, [manual, finance, stale, none]);
    const v = valueOnHand([
      { skuId: manual, qty: "10" },
      { skuId: manual, qty: "0.5" },      // 同 SKU 多行（多仓/批次）汇总
      { skuId: finance, qty: "100.0000" },
      { skuId: stale, qty: "40" },
      { skuId: none, qty: "60" },
    ], costs);
    // manual 10.5 × 12.3456 = 129.6288 → 129.63；finance 100 × 9.25 = 925.00
    expect(v.amount).toBe("1054.63");
    expect(v.coveredQty).toBe("110.5000");
    expect(v.uncoveredQty).toBe("100.0000");
    expect(v.coveragePct).toBe(52.49);
    expect(v.coveredSkus).toBe(2);
    expect(v.uncoveredSkus).toBe(2);
    expect(v.uncoveredSkuIds).toEqual([stale, none].sort((a, b) => a - b));
    expect(v.bySource.sku_costs).toEqual({ amount: "129.63", qty: "10.5000", skus: 1 });
    expect(v.bySource.finance_observation).toEqual({ amount: "925.00", qty: "100.0000", skus: 1 });
  });

  it("valueOnHand：空在库 → 覆盖率 null、金额 0", () => {
    expect(valueOnHand([], new Map())).toMatchObject({ amount: "0.00", coveragePct: null, coveredSkus: 0, uncoveredSkus: 0 });
  });
});
