/**
 * releaseSnapshots（D20 运营环）：快照仓最新库存周期刷新。
 * 铁律：只吃快照仓（实时仓阻塞防双套账）；同键 upsert 幂等；dry-run 零写入；
 * 已提交行不再入选；零量行提交但不落快照。
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
  it("快照仓聚合 upsert；实时仓阻塞；零量行提交不落快照；dry-run 零写入；重放幂等", async () => {
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

    // dry-run：零写入
    const dry = await releaseSnapshots(pmc, { bizDate: "2026-07-24", dryRun: true }, db);
    expect(dry.dryRun).toBe(true);
    expect(dry.upserts).toBe(1);
    expect(dry.zeroSkipped).toBe(1);
    expect(dry.blocked).toHaveLength(2);
    expect((await db.select().from(schema.stockSnapshots)).length).toBe(0);

    // 执行：42 聚合入快照；零量行 committed；阻塞行留 pending 带原因
    const run = await releaseSnapshots(pmc, { bizDate: "2026-07-24", dryRun: false }, db);
    expect(run.upserts).toBe(1);
    expect(run.rowsCommitted).toBe(3); // 2 聚合行 + 1 零量行
    const snaps = await db.select().from(schema.stockSnapshots);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].warehouseId).toBe(snapWh.id);
    expect(snaps[0].skuId).toBe(sku.id);
    expect(snaps[0].qty).toBe("42.0000");
    const staged = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, job));
    expect(staged.filter((r) => r.status === "committed")).toHaveLength(3);
    const blockedRows = staged.filter((r) => r.status === "pending");
    expect(blockedRows).toHaveLength(2);
    expect(blockedRows.map((r) => r.errorMsg).join("|")).toMatch(/实时仓不吃快照|别名未认领/);

    // 重放：已提交行不再入选；同键新一期 bizDate 落新行，旧行保留（时间序列）
    const job2 = await newJob(db);
    await writeStagingRows(db, job2, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 50 } },
    ]);
    const run2 = await releaseSnapshots(pmc, { bizDate: "2026-07-25", dryRun: false }, db);
    expect(run2.upserts).toBe(1);
    const all = await db.select().from(schema.stockSnapshots);
    expect(all).toHaveLength(2);
    const d25 = all.find((s) => s.bizDate === "2026-07-25");
    expect(d25?.qty).toBe("50.0000");

    // 同期重导（同 bizDate）：upsert 覆盖不重复
    const job3 = await newJob(db);
    await writeStagingRows(db, job3, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { warehouseRaw: "天猫中心仓", skuCode: "N001-000", qty: 55 } },
    ]);
    await releaseSnapshots(pmc, { bizDate: "2026-07-25", dryRun: false }, db);
    const after = await db.select().from(schema.stockSnapshots);
    expect(after).toHaveLength(2);
    expect(after.find((s) => s.bizDate === "2026-07-25")?.qty).toBe("55.0000");
  });
});
