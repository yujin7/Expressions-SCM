/**
 * D65 数据质量总览读模型（来源 × 维度）：
 * - rpa：recon_diffs 一致率（容差）+ 盘点命中率 + 快照跳变；manual：模板放行率；external：一致性；reference：不度量；
 * - 手工改写指标独立计数；覆盖起止只取证不补 0；缓存绑定随事实变化失效。
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeDataQuality, DATA_QUALITY_CACHE_KEY, loadDataQuality, refreshDataQuality } from "@/server/modules/report/data-quality";

const today = new Date().toISOString().slice(0, 10);
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  const { db, client } = await createTestDb();
  const [actor] = await db.insert(schema.users).values({ name: "数据责任人", roles: ["pmc"] }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P90020", nameCn: "质量测试" }).returning();
  const mk = async (code: string) => (await db.insert(schema.skus).values({ code, name: code, spuId: spu.id, skuType: "finished", baseUom: "支" }).returning())[0];
  const s1 = await mk("DQ-1");
  const s2 = await mk("DQ-2");
  const s3 = await mk("DQ-3");
  const [rt] = await db.insert(schema.warehouses).values({ code: "RT", name: "实时仓", kind: "finished", accountingMode: "realtime" }).returning();
  const [snap] = await db.insert(schema.warehouses).values({ code: "SN", name: "快照仓", kind: "snapshot", accountingMode: "snapshot" }).returning();
  // recon：4 行，容差 1%：100/100 一致、200/201 一致(0.5%)、50/60 不一致、0/0 一致 → 75%
  await db.insert(schema.reconDiffs).values([
    { bizDate: daysAgo(1), skuId: s1.id, sysQty: "100.0000", jstQty: "100.0000", diffQty: "0.0000" },
    { bizDate: daysAgo(1), skuId: s2.id, sysQty: "200.0000", jstQty: "201.0000", diffQty: "-1.0000" },
    { bizDate: daysAgo(2), skuId: s3.id, sysQty: "50.0000", jstQty: "60.0000", diffQty: "-10.0000" },
    { bizDate: daysAgo(2), skuId: s1.id, sysQty: "0.0000", jstQty: "0.0000", diffQty: "0.0000" },
    // 窗口外不计
    { bizDate: daysAgo(60), skuId: s2.id, sysQty: "1.0000", jstQty: "999.0000", diffQty: "-998.0000" },
  ]);
  // 盘点：已审批 PD 三行两命中 → 66.67%
  const [pd] = await db.insert(schema.pdDocs).values({ docNo: "PD-DQ-1", status: "approved", warehouseId: rt.id, bizDate: daysAgo(3), createdBy: actor.id }).returning();
  await db.insert(schema.pdLines).values([
    { pdId: pd.id, skuId: s1.id, bookQty: "10.0000", countedQty: "10.0000" },
    { pdId: pd.id, skuId: s2.id, bookQty: "20.0000", countedQty: "19.0000" },
    { pdId: pd.id, skuId: s3.id, bookQty: "5.0000", countedQty: "5.0000" },
  ]);
  // 快照：上一批 3 SKU 共 300，本批 1 SKU 共 100 → qty_jump + vanished
  await db.insert(schema.stockSnapshots).values([
    { warehouseId: snap.id, skuId: s1.id, bizDate: daysAgo(2), qty: "100.0000" },
    { warehouseId: snap.id, skuId: s2.id, bizDate: daysAgo(2), qty: "100.0000" },
    { warehouseId: snap.id, skuId: s3.id, bizDate: daysAgo(2), qty: "100.0000" },
    { warehouseId: snap.id, skuId: s1.id, bizDate: daysAgo(1), qty: "100.0000" },
  ]);
  // 导入任务：人工模板 90/10 → 90%；参考模板 100% ；未登记模板
  await db.insert(schema.importJobs).values([
    { template: "sales", filename: "s.xlsx", status: "done", okRows: 90, failRows: 10, sourceAsOf: daysAgo(5), createdBy: actor.id },
    { template: "bom", filename: "b.xlsx", status: "done", okRows: 40, failRows: 0, sourceAsOf: daysAgo(20), createdBy: actor.id },
    { template: "mystery_template", filename: "m.xlsx", status: "done", okRows: 1, failRows: 0, createdBy: actor.id },
  ]);
  // 手工改写：本月 1 条修正（supersedes）+ 1 条原始（不算）
  const [orig] = await db.insert(schema.salesAmountMonthly).values({ yearMonth: "2026-08", scopeKind: "company", amount: "100.00", createdBy: actor.id }).returning();
  await db.insert(schema.salesAmountMonthly).values({ yearMonth: "2026-08", scopeKind: "company", amount: "120.00", supersedesId: orig.id, createdBy: actor.id });
  await db.insert(schema.dataQualityReviews).values({ periodKind: "week", periodKey: "2026-W35", sourceClass: "rpa_warehouse", status: "pending" });
  return { db, client, snap, rt, s1 };
}

describe("数据质量总览", () => {
  it("来源 × 维度只算能算的；手工改写独立计数；快照跳变告警", async () => {
    const { db, client, snap } = await seed();
    try {
      const r = await computeDataQuality(db, { today });
      expect(r.version).toBe(DATA_QUALITY_CACHE_KEY);
      expect(r.sources.map((s) => s.sourceClass)).toEqual(["rpa_warehouse", "manual_po_chain", "external_platform", "reference_file"]);

      const rpa = r.sources[0];
      expect(r.recon).toMatchObject({ matched: 3, total: 4, rate: 75 });
      expect(rpa.accuracy).toMatchObject({ rate: 75, n: 4, targetPct: 95, status: "below_target" });
      expect(rpa.timeliness).toMatchObject({ latestAsOf: daysAgo(1), ageDays: 1, status: "current" });
      expect(rpa.coverage).toMatchObject({ from: daysAgo(2), through: daysAgo(1) });
      expect(rpa.uniqueness.rate).toBeNull();
      expect(r.count).toMatchObject({ docs: 1, lines: 3, hits: 2, rate: 66.67 });
      expect(r.snapshotQuality.alerts).toBe(1);
      expect(r.snapshotQuality.warehouses[0]).toMatchObject({
        warehouseId: snap.id, prevBizDate: daysAgo(2), nextBizDate: daysAgo(1), prevRows: 3, nextRows: 1, vanished: 2, qtyDeltaPct: -66.67,
      });
      expect(r.snapshotQuality.warehouses[0].flags).toEqual(expect.arrayContaining(["qty_jump", "vanished"]));

      const manual = r.sources[1];
      expect(manual.completeness).toMatchObject({ rate: 90, ok: 90, rejected: 10, n: 100 });
      expect(manual.accuracy).toMatchObject({ rate: 90, targetPct: 90, status: "ok" });
      expect(manual.uniqueness.rate).toBe(100);
      expect(manual.timeliness.status).toBe("unknown"); // 没有单据

      const external = r.sources[2];
      expect(external.accuracy).toMatchObject({ rate: null, status: "unknown", targetPct: 90 });
      expect(external.uniqueness).toMatchObject({ rate: null, duplicates: 0 });
      expect(r.salesConsistency.state).toBe("insufficient");

      const ref = r.sources[3];
      expect(ref.accuracy).toMatchObject({ rate: null, targetPct: null, status: "unknown" });
      expect(ref.completeness).toMatchObject({ rate: 100, n: 40 });
      expect(ref.coverage).toMatchObject({ from: daysAgo(20), through: daysAgo(20) });
      expect(ref.timeliness).toMatchObject({ latestAsOf: daysAgo(20), ageDays: 20, status: "current" });

      expect(r.manualOverrides).toMatchObject({ period: today.slice(0, 7), count: 1 });
      expect(r.reviews.pending).toBe(1);
      expect(r.unregisteredTemplates).toEqual(["mystery_template"]);
      expect(r.tolerancePct).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("空库全部留空不补 0；缓存命中与绑定失效", async () => {
    const { db, client } = await createTestDb();
    try {
      const r = await loadDataQuality(db, { today });
      for (const s of r.sources) {
        expect(s.accuracy.rate).toBeNull();
        expect(s.completeness.rate).toBeNull();
        expect(s.timeliness.status).toBe("unknown");
        expect(s.coverage).toMatchObject({ from: null, through: null });
      }
      expect(r.manualOverrides.count).toBe(0);
      const [cache] = await db.select().from(schema.reportReadModelCache).where(eq(schema.reportReadModelCache.key, DATA_QUALITY_CACHE_KEY));
      expect(cache.key).toBe(DATA_QUALITY_CACHE_KEY);
      // 新增 pending 核对 → 绑定变化 → 重算后 pending=1
      await db.insert(schema.dataQualityReviews).values({ periodKind: "month", periodKey: "2026-08", sourceClass: "external_platform" });
      expect((await loadDataQuality(db, { today })).reviews.pending).toBe(1);
      expect((await refreshDataQuality(db, { today })).reviews.pending).toBe(1);
    } finally {
      await client.close();
    }
  });
});
