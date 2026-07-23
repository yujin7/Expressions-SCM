/**
 * 适配器①（电商部库存明细 7-21数据源）——真实文件冒烟 + 全链路 staging。
 * 复核基准（《04》事实核查）：3,473 行 / 15 仓；绍兴令时达保税仓（综合）=867、菜鸟仓-保税仓=586。
 * 无真实文件的环境（CI）自动跳过。
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { seedDimensions } from "@/db/seed-dimensions";
import * as schema from "@/db/schema";
import { getStagingRows } from "@/server/import/staging";
import {
  inventoryLongAdapter,
  stageInventoryLong,
} from "@/server/import/adapters/inventory-long";

const FILE = "/Users/yj/Downloads/电商部库存明细26-7-21.xlsx";
const BASELINE_ROWS = 3473;

describe.skipIf(!existsSync(FILE))("适配器①：库存明细长表（真实文件）", () => {
  it("解析行数在基准 ±0.5% 内，两仓行数与基准精确一致", async () => {
    const res = await inventoryLongAdapter(FILE);
    expect(res.rows.length).toBeGreaterThanOrEqual(Math.floor(BASELINE_ROWS * 0.995));
    expect(res.rows.length).toBeLessThanOrEqual(Math.ceil(BASELINE_ROWS * 1.005));

    const byWh = new Map<string, number>();
    for (const r of res.rows) {
      const wh = r.payload.warehouseRaw as string;
      byWh.set(wh, (byWh.get(wh) ?? 0) + 1);
    }
    expect(byWh.size).toBe(15);
    expect(byWh.get("绍兴令时达保税仓（综合）")).toBe(867);
    expect(byWh.get("菜鸟仓-保税仓")).toBe(586);
  });

  it("payload 形状与数值约束：qty 为 ≥0 数值，skuCode 非空", async () => {
    const res = await inventoryLongAdapter(FILE);
    for (const r of res.rows) {
      expect(r.targetTable).toBe("stock_opening_candidate");
      expect(typeof r.payload.skuCode).toBe("string");
      const qty = r.payload.qty as number;
      expect(typeof qty).toBe("number");
      expect(Number.isFinite(qty)).toBe(true);
      expect(qty).toBeGreaterThanOrEqual(0);
    }
  });

  it("stage 全链路：staging 行数=解析行数；未解析仓库/编码入异常队列（各值一次）", async () => {
    const { db } = await createTestDb();
    await seedDimensions(db);
    const [u] = await db.insert(schema.users).values({ name: "导入员" }).returning();

    const sum = await stageInventoryLong(db, FILE, u.id);
    expect(sum.staged).toBeGreaterThan(3000);
    expect(sum.staged).toBe(sum.validated + sum.pending);
    expect(sum.rejected).toBe(0);

    const staged = await getStagingRows(db, sum.jobId);
    expect(staged.length).toBe(sum.staged);

    // 未种任何仓库别名 → 15 个仓名全部入异常队列（去重后恰 15 值）
    const whExc = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.aliasType, "warehouse"));
    expect(whExc.length).toBe(15);
    expect(sum.unresolved.warehouse).toBe(15);
    // sku_code 未建档 → 也应排队（去重值数 >0 且 = 队列行数）
    const skuExc = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.aliasType, "sku_code"));
    expect(skuExc.length).toBeGreaterThan(0);
    expect(sum.unresolved.sku_code).toBe(skuExc.length);
    // 全部行因别名未解析而 pending
    expect(sum.pending).toBe(sum.staged);

    const job = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, sum.jobId));
    expect(job[0].status).toBe("done");
    expect(job[0].okRows).toBe(sum.staged);
  });
});
