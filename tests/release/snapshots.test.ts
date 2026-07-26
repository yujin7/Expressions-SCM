/**
 * releaseSnapshots（D20 运营环）：快照仓最新库存周期刷新。
 * 铁律：只吃快照仓（实时仓阻塞防双套账）；同键 upsert 幂等；dry-run 零写入；
 * 显式任务、预演摘要绑定、完整性硬闸、零量覆盖与来源追溯。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import { releaseSnapshots, type ReleaseUser } from "@/server/modules/release/engine";

const pmc: ReleaseUser = { id: 1, name: "放行员", roles: ["pmc"], isApprover: false };

async function newJob(db: TestDb): Promise<number> {
  const [j] = await db
    .insert(schema.importJobs)
    .values({ template: "test", filename: "t.xlsx", status: "done", createdBy: 1 })
    .returning({ id: schema.importJobs.id });
  return j.id;
}

async function seed(db: TestDb) {
  const [spu] = await db.insert(schema.spus).values({ code: "P00001", nameCn: "面膜" }).returning();
  const [sku] = await db
    .insert(schema.skus)
    .values({ code: "N001-000", name: "面膜", spuId: spu.id, skuType: "finished", baseUom: "件" })
    .returning();
  const [snapWh] = await db
    .insert(schema.warehouses)
    .values({ code: "WS1", name: "天猫中心仓", kind: "snapshot", accountingMode: "snapshot" })
    .returning();
  await db.insert(schema.aliases).values({ aliasType: "warehouse", rawValue: "天猫中心仓", targetId: snapWh.id });
  const [ownWh] = await db
    .insert(schema.warehouses)
    .values({ code: "WO1", name: "自有仓", kind: "finished", accountingMode: "realtime" })
    .returning();
  await db.insert(schema.aliases).values({ aliasType: "warehouse", rawValue: "自有仓", targetId: ownWh.id });
  return { sku, snapWh, ownWh };
}

describe("releaseSnapshots", () => {
  it("存在实时仓或未知身份时只允许预演，拒绝部分放行", async () => {
    const { db } = await createTestDb();
    const { sku, snapWh } = await seed(db);
    const job = await newJob(db);
    await writeStagingRows(db, job, [
      // 同仓同码两行 → 聚合为一键
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 30 } },
      { rowNo: 2, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 12 } },
      // 实时仓 → 阻塞
      { rowNo: 3, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "自有仓", skuCode: "N001-000", qty: 5 } },
      // 零量 → 提交但不落快照
      { rowNo: 4, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 0 } },
      // 未知 SKU → 阻塞
      { rowNo: 5, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "X404", qty: 9 } },
    ]);

    const dry = await releaseSnapshots(pmc, { jobIds: [job], bizDate: "2026-07-24", dryRun: true }, db);
    expect(dry.dryRun).toBe(true);
    expect(dry.upserts).toBe(1);
    expect(dry.zeroRows).toBe(1);
    expect(dry.blocked).toHaveLength(2);
    expect((await db.select().from(schema.stockSnapshots)).length).toBe(0);

    await expect(
      releaseSnapshots(
        pmc,
        { jobIds: [job], bizDate: "2026-07-24", expectedDigest: dry.releaseDigest, dryRun: false },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.stockSnapshots)).toHaveLength(0);
    const staged = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, job));
    expect(staged.every((r) => r.status !== "committed")).toBe(true);
  });

  it("正数后显式零量会清零，不残留旧库存；执行绑定预演摘要与导入任务", async () => {
    const { db } = await createTestDb();
    const { sku, snapWh } = await seed(db);
    const job1 = await newJob(db);
    await writeStagingRows(db, job1, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 42 } },
    ]);
    await db.update(schema.importJobs).set({ okRows: 1 }).where(eq(schema.importJobs.id, job1));
    const dry1 = await releaseSnapshots(pmc, { jobIds: [job1], bizDate: "2026-07-24", dryRun: true }, db);
    const run1 = await releaseSnapshots(
      pmc,
      { jobIds: [job1], bizDate: "2026-07-24", expectedDigest: dry1.releaseDigest, dryRun: false },
      db,
    );
    expect(run1.rowsCommitted).toBe(1);
    expect((await db.select().from(schema.stockSnapshots))[0]).toMatchObject({
      warehouseId: snapWh.id,
      skuId: sku.id,
      importJobId: job1,
      qty: "42.0000",
    });

    const job2 = await newJob(db);
    await writeStagingRows(db, job2, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 0 } },
    ]);
    await db.update(schema.importJobs).set({ okRows: 1 }).where(eq(schema.importJobs.id, job2));
    const dry2 = await releaseSnapshots(pmc, { jobIds: [job2], bizDate: "2026-07-25", dryRun: true }, db);
    const run2 = await releaseSnapshots(
      pmc,
      { jobIds: [job2], bizDate: "2026-07-25", expectedDigest: dry2.releaseDigest, dryRun: false },
      db,
    );
    expect(run2.zeroRows).toBe(1);
    const all = await db.select().from(schema.stockSnapshots);
    expect(all).toHaveLength(2);
    const d25 = all.find((s) => s.bizDate === "2026-07-25");
    expect(d25).toMatchObject({ qty: "0.0000", importJobId: job2 });

    const job3 = await newJob(db);
    await writeStagingRows(db, job3, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 55 } },
    ]);
    await db.update(schema.importJobs).set({ okRows: 1 }).where(eq(schema.importJobs.id, job3));
    const stale = await releaseSnapshots(pmc, { jobIds: [job3], bizDate: "2026-07-25", dryRun: true }, db);
    await writeStagingRows(db, job3, [
      { rowNo: 2, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 1 } },
    ]);
    await db.update(schema.importJobs).set({ okRows: 2 }).where(eq(schema.importJobs.id, job3));
    await expect(
      releaseSnapshots(
        pmc,
        { jobIds: [job3], bizDate: "2026-07-25", expectedDigest: stale.releaseDigest, dryRun: false },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("同一导入任务只能放行一次，重放不新增审计或改写快照", async () => {
    const { db } = await createTestDb();
    await seed(db);
    const job = await newJob(db);
    await writeStagingRows(db, job, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 12 } },
    ]);
    await db.update(schema.importJobs).set({ okRows: 1 }).where(eq(schema.importJobs.id, job));

    const preview = await releaseSnapshots(pmc, {
      jobIds: [job],
      bizDate: "2026-07-21",
      dryRun: true,
    }, db);
    await releaseSnapshots(pmc, {
      jobIds: [job],
      bizDate: "2026-07-21",
      expectedDigest: preview.releaseDigest,
      dryRun: false,
    }, db);

    await expect(releaseSnapshots(pmc, {
      jobIds: [job],
      bizDate: "2026-07-21",
      expectedDigest: preview.releaseDigest,
      dryRun: false,
    }, db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("不可重复执行"),
    });

    expect(await db.select().from(schema.stockSnapshots)).toHaveLength(1);
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entity, "release_snapshot"));
    expect(audits).toHaveLength(1);
  });
});
