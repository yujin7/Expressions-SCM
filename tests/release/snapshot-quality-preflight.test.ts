/**
 * D65 快照放行预检：同仓「上一批 vs 本批」控制量对比（rules/snapshot-quality）写入 dry-run 结果与 releaseManifest，
 * 只警告不阻断；无上一批只出行数（empty_prev，不告警）。
 * 阈值与数据质量读模型同源（sys_params dq_snapshot_qty_jump_pct / dq_snapshot_vanished_pct）：改参数后预检警告随之变化。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import { releaseSnapshots, type ReleaseUser } from "@/server/modules/release/engine";

const pmc: ReleaseUser = { id: 1, name: "放行员", roles: ["pmc"], isApprover: false };

async function newJob(db: TestDb, okRows: number): Promise<number> {
  const [j] = await db.insert(schema.importJobs)
    .values({ template: "stock_summary", filename: "t.xlsx", status: "done", okRows, createdBy: 1 })
    .returning({ id: schema.importJobs.id });
  return j.id;
}

async function seed(db: TestDb) {
  const [spu] = await db.insert(schema.spus).values({ code: "P00002", nameCn: "精华" }).returning();
  const mk = async (code: string) => (await db.insert(schema.skus)
    .values({ code, name: code, spuId: spu.id, skuType: "finished", baseUom: "件" }).returning())[0];
  const a = await mk("N002-000");
  const b = await mk("N003-000");
  const c = await mk("N004-000");
  const [wh] = await db.insert(schema.warehouses)
    .values({ code: "WS2", name: "云仓", kind: "snapshot", accountingMode: "snapshot" }).returning();
  await db.insert(schema.aliases).values({ aliasType: "warehouse", rawValue: "云仓", targetId: wh.id });
  return { a, b, c, wh };
}

describe("releaseSnapshots 快照质量预检", () => {
  it("无上一批 → empty_prev 不告警；总量跳变与 SKU 消失 → 警告但照常放行，manifest 留证", async () => {
    const { db } = await createTestDb();
    const { wh } = await seed(db);

    const job1 = await newJob(db, 3);
    await writeStagingRows(db, job1, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "云仓", skuCode: "N002-000", qty: 100 } },
      { rowNo: 2, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "云仓", skuCode: "N003-000", qty: 100 } },
      { rowNo: 3, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "云仓", skuCode: "N004-000", qty: 100 } },
    ]);
    const dry1 = await releaseSnapshots(pmc, { jobIds: [job1], bizDate: "2026-09-01", dryRun: true }, db);
    expect(dry1.snapshotQuality).toHaveLength(1);
    expect(dry1.snapshotQuality[0]).toMatchObject({ warehouseId: wh.id, prevBizDate: null, prevRows: 0, nextRows: 3, flags: ["empty_prev"], warning: false });
    await releaseSnapshots(pmc, { jobIds: [job1], bizDate: "2026-09-01", expectedDigest: dry1.releaseDigest, dryRun: false }, db);

    // 第二批：只剩 1 个 SKU、总量 100 → 跳变 −66.67%、消失 2/3
    const job2 = await newJob(db, 1);
    await writeStagingRows(db, job2, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "云仓", skuCode: "N002-000", qty: 100 } },
    ]);
    const dry2 = await releaseSnapshots(pmc, { jobIds: [job2], bizDate: "2026-09-02", dryRun: true }, db);
    expect(dry2.blocked).toHaveLength(0);
    expect(dry2.snapshotQuality[0]).toMatchObject({
      warehouseId: wh.id, prevBizDate: "2026-09-01", prevRows: 3, nextRows: 1, prevQty: "300.0000", nextQty: "100.0000",
      qtyDeltaPct: -66.67, vanished: 2, vanishedPct: 66.67, negatives: 0, warning: true,
    });
    expect(dry2.snapshotQuality[0].flags).toEqual(expect.arrayContaining(["qty_jump", "vanished"]));

    // 只警告不阻断：执行成功，manifest 与审计留证
    const run2 = await releaseSnapshots(pmc, { jobIds: [job2], bizDate: "2026-09-02", expectedDigest: dry2.releaseDigest, dryRun: false }, db);
    expect(run2.rowsCommitted).toBe(1);
    expect(run2.snapshotQuality[0].warning).toBe(true);
    const [job] = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, job2));
    const manifest = job.releaseManifest as { snapshotQuality?: { warehouseId: number; flags: string[]; warning: boolean }[] };
    expect(manifest.snapshotQuality).toHaveLength(1);
    expect(manifest.snapshotQuality?.[0]).toMatchObject({ warehouseId: wh.id, warning: true });
    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "release_snapshot"));
    const last = audits[audits.length - 1].after as { snapshotQualityWarnings?: { warehouseId: number }[] };
    expect(last.snapshotQualityWarnings).toEqual([{ warehouseId: wh.id, flags: expect.arrayContaining(["qty_jump", "vanished"]) }]);
    expect(await db.select().from(schema.stockSnapshots)).toHaveLength(4);

    // 预检阈值读 sys_params（与 data-quality 读模型同参）：放宽到 80% / 70% → 同样的跳变不再告警
    await db.insert(schema.sysParams).values([
      { scope: "global", key: "dq_snapshot_qty_jump_pct", value: "80" },
      { scope: "global", key: "dq_snapshot_vanished_pct", value: "70" },
    ]);
    const job3 = await newJob(db, 1);
    await writeStagingRows(db, job3, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "云仓", skuCode: "N003-000", qty: 300 } },
    ]);
    const dry3 = await releaseSnapshots(pmc, { jobIds: [job3], bizDate: "2026-09-03", dryRun: true }, db);
    // 上一批 100（N002）→ 本批 300（N003）：跳变 +200%、消失 1/1=100% → 高于放宽后的阈值仍告警
    expect(dry3.snapshotQuality[0]).toMatchObject({ prevBizDate: "2026-09-02", qtyDeltaPct: 200, vanishedPct: 100, warning: true });
    await db.update(schema.sysParams).set({ value: "250" }).where(eq(schema.sysParams.key, "dq_snapshot_qty_jump_pct"));
    await db.update(schema.sysParams).set({ value: "100" }).where(eq(schema.sysParams.key, "dq_snapshot_vanished_pct"));
    const dry3b = await releaseSnapshots(pmc, { jobIds: [job3], bizDate: "2026-09-03", dryRun: true }, db);
    expect(dry3b.snapshotQuality[0]).toMatchObject({ qtyDeltaPct: 200, vanishedPct: 100, flags: [], warning: false });
    await db.update(schema.sysParams).set({ value: "150" }).where(eq(schema.sysParams.key, "dq_snapshot_qty_jump_pct"));
    const dry3c = await releaseSnapshots(pmc, { jobIds: [job3], bizDate: "2026-09-03", dryRun: true }, db);
    expect(dry3c.snapshotQuality[0]).toMatchObject({ flags: ["qty_jump"], warning: true });
  });
});
