/**
 * releaseBatchStocks 顺带回填主档保质期（D13）。
 *
 * 背景：适配器早已从效期文件解析出保质期并落进 staging，放行引擎却从未写回主档——
 * 实测 dev 库 1026/1026 在售成品的 skus.shelf_life_days 全为空，
 * 「我们的临期阈值够不够渠道用」因此根本无法回答（渠道按 max(保质期×2/10,100天) 判临期）。
 * 是「解析了没落库」，不是没采集。
 *
 * 三条纪律，逐条上锁：
 *  ① 只填空，绝不覆盖人工已设的值（主档以人为准）；
 *  ② 同 SKU 文件内保质期互相矛盾 → 记 conflicted 不猜（《绝不猜》）；
 *  ③ dry-run 零写入。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import { releaseBatchStocks, type ReleaseUser } from "@/server/modules/release/engine";

const ops: ReleaseUser = { id: 1, name: "放行员", roles: ["admin"], isApprover: true };

describe("releaseBatchStocks：主档保质期回填（D13）", () => {
  async function setup() {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({ username: "u", name: "放行员", passwordHash: "x", active: true });
    const [spu] = await db.insert(schema.spus).values({ code: "SPU-1", nameCn: "测试" }).returning();
    const [wh] = await db
      .insert(schema.warehouses)
      .values({ code: "W1", name: "自有仓", kind: "finished" })
      .returning();
    await db.insert(schema.aliases).values({ aliasType: "warehouse", rawValue: "自有仓", targetId: wh.id });
    return { db, spuId: spu.id, whId: wh.id };
  }

  async function mkSku(db: TestDb, spuId: number, code: string, shelf: number | null) {
    const [s] = await db
      .insert(schema.skus)
      .values({ spuId, code, name: code, skuType: "finished", baseUom: "件", active: true, shelfLifeDays: shelf })
      .returning();
    return s.id;
  }

  async function stage(db: TestDb, rows: Record<string, unknown>[]) {
    const [j] = await db
      .insert(schema.importJobs)
      .values({ template: "expiry", filename: "e.xlsx", status: "done", createdBy: 1 })
      .returning({ id: schema.importJobs.id });
    await writeStagingRows(
      db,
      j.id,
      rows.map((payload, i) => ({ rowNo: i + 1, targetTable: "batch_stock", payload })),
    );
    return j.id;
  }

  const row = (code: string, shelf: number | null, qty = 10) => ({
    sheetWarehouse: "自有仓",
    skuCode: code,
    prodDate: "2026-01-01",
    expiryDate: "2029-01-01",
    shelfLifeDays: shelf,
    qty,
    stocktakeDate: "2026-07-21",
  });

  it("主档为空时按文件回填", async () => {
    const { db, spuId } = await setup();
    const id = await mkSku(db, spuId, "FG-1", null);
    const jobId = await stage(db, [row("FG-1", 1095)]);

    const r = await releaseBatchStocks(ops, { jobIds: [jobId], dryRun: false }, db);
    expect(r.shelfLife.filled).toBe(1);
    const [s] = await db.select().from(schema.skus).where(eq(schema.skus.id, id));
    expect(s.shelfLifeDays).toBe(1095);
  });

  it("主档已有值时绝不覆盖（人工设定优先）", async () => {
    const { db, spuId } = await setup();
    const id = await mkSku(db, spuId, "FG-2", 730); // 业务已核定 730
    const jobId = await stage(db, [row("FG-2", 1095)]); // 文件说 1095

    const r = await releaseBatchStocks(ops, { jobIds: [jobId], dryRun: false }, db);
    expect(r.shelfLife.filled).toBe(0);
    const [s] = await db.select().from(schema.skus).where(eq(schema.skus.id, id));
    expect(s.shelfLifeDays, "人工已设的 730 不得被文件里的 1095 覆盖").toBe(730);
  });

  it("同 SKU 保质期互相矛盾 → 记 conflicted，一个都不写（绝不猜）", async () => {
    const { db, spuId } = await setup();
    const id = await mkSku(db, spuId, "FG-3", null);
    const jobId = await stage(db, [row("FG-3", 1095), row("FG-3", 730, 5)]);

    const r = await releaseBatchStocks(ops, { jobIds: [jobId], dryRun: false }, db);
    expect(r.shelfLife.conflicted).toContain("FG-3");
    expect(r.shelfLife.filled).toBe(0);
    const [s] = await db.select().from(schema.skus).where(eq(schema.skus.id, id));
    expect(s.shelfLifeDays, "矛盾时不得二选一").toBeNull();
  });

  it("dry-run 零写入，但预览候选数", async () => {
    const { db, spuId } = await setup();
    const id = await mkSku(db, spuId, "FG-4", null);
    const jobId = await stage(db, [row("FG-4", 1095)]);

    const r = await releaseBatchStocks(ops, { jobIds: [jobId], dryRun: true }, db);
    expect(r.dryRun).toBe(true);
    expect(r.shelfLife.filled).toBe(1); // 候选
    const [s] = await db.select().from(schema.skus).where(eq(schema.skus.id, id));
    expect(s.shelfLifeDays, "dry-run 不得落库").toBeNull();
  });

  it("重放幂等：第二次放行不再重复回填", async () => {
    const { db, spuId } = await setup();
    await mkSku(db, spuId, "FG-5", null);
    const jobId = await stage(db, [row("FG-5", 1095)]);

    const a = await releaseBatchStocks(ops, { jobIds: [jobId], dryRun: false }, db);
    expect(a.shelfLife.filled).toBe(1);
    const b = await releaseBatchStocks(ops, { jobIds: [jobId], dryRun: false }, db);
    expect(b.shelfLife.filled, "已填过的不再计数（IS NULL 条件自然幂等）").toBe(0);
  });
});
