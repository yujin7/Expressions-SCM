/**
 * 适配器②（7月电商组效期占比-仅数量 → batch_stock）——真实文件冒烟 + 全链路。
 * 复核基准：6 明细页；保质期天数有值 ~3,131 行，其中 ≥99% = 1095（D13：疑似全默认三年）。
 * 无真实文件的环境（CI）自动跳过。
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { seedDimensions } from "@/db/seed-dimensions";
import * as schema from "@/db/schema";
import { getStagingRows } from "@/server/import/staging";
import { expiryAdapter, stageExpiry } from "@/server/import/adapters/expiry";

const FILE = "/Users/yj/Downloads/7月电商组效期占比情况-仅数量.xlsx";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

describe.skipIf(!existsSync(FILE))("适配器②：效期批次库存（真实文件）", () => {
  it("6 个明细页；总行数 >3,000；保质期天数 ≥99% 为 1095", async () => {
    const res = await expiryAdapter(FILE);
    expect(res.stats.detailSheets).toBe(6);
    expect(res.rows.length).toBeGreaterThan(3000);

    expect(res.stats.shelfLifePopulated).toBeGreaterThan(3000);
    const ratio = res.stats.shelfLife1095 / res.stats.shelfLifePopulated;
    expect(ratio).toBeGreaterThanOrEqual(0.99);
  });

  it("四种日期编码归一：prodDate/expiryDate/stocktakeDate 均为 YYYY-MM-DD 或 null", async () => {
    const res = await expiryAdapter(FILE);
    let prodDates = 0;
    for (const r of res.rows) {
      for (const key of ["prodDate", "expiryDate", "stocktakeDate"] as const) {
        const v = r.payload[key];
        if (v !== null) {
          expect(typeof v).toBe("string");
          expect(v as string).toMatch(DATE_RE);
        }
      }
      if (r.payload.prodDate !== null) prodDates++;
      const shelf = r.payload.shelfLifeDays;
      expect(shelf === null || (typeof shelf === "number" && Number.isFinite(shelf))).toBe(true);
      expect(typeof r.payload.qty).toBe("number");
      expect(typeof r.payload.skuCode).toBe("string");
    }
    expect(prodDates).toBeGreaterThan(3000); // 生产日期基本全量（序列数/ISO/JSDate 串混排均须归一成功）
  });

  it("公式下拉残留行（仅盘点期间有值）按空行跳过，不污染拒收道", async () => {
    const res = await expiryAdapter(FILE);
    expect(res.stats.fillDownSkipped).toBeGreaterThan(0);
    expect(res.stats.rejected).toBe(0);
  });

  it("stage 全链路：staged >3,000；页名作为仓库别名排队恰 6 值", async () => {
    const { db } = await createTestDb();
    await seedDimensions(db);
    const [u] = await db.insert(schema.users).values({ name: "导入员" }).returning();

    const sum = await stageExpiry(db, FILE, u.id);
    expect(sum.staged).toBeGreaterThan(3000);
    expect(sum.rejected).toBe(0);

    const staged = await getStagingRows(db, sum.jobId);
    expect(staged.length).toBe(sum.staged);
    expect(staged.every((r: { targetTable: string | null }) => r.targetTable === "batch_stock")).toBe(true);

    const whExc = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.aliasType, "warehouse"));
    expect(whExc.length).toBe(6); // 6 个明细页名
    expect(sum.unresolved.warehouse).toBe(6);
    expect(sum.unresolved.sku_code ?? 0).toBeGreaterThan(0);
  });
});
