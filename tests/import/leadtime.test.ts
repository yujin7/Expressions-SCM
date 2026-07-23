/**
 * 适配器④（双来源 → sku_leadtime）——真实文件冒烟 + 全链路。
 * 来源(a) 销量汇总「生产周期统计」：常规生产周期「待确认」=37 行 → null（绝非 NaN）。
 * 来源(b) 在途进度表「生产周期明细」（畸形文件，仅 ooxml 通道）：~700 行。
 * 两来源各 stage >400 行。无真实文件的环境（CI）自动跳过。
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { seedDimensions } from "@/db/seed-dimensions";
import * as schema from "@/db/schema";
import { getStagingRows } from "@/server/import/staging";
import { leadtimeAdapter, stageLeadtime } from "@/server/import/adapters/leadtime";

const FILE_A = "/Users/yj/Downloads/26年产品销量汇总（6月）.xlsx";
const FILE_B = "/Users/yj/Downloads/2026年成品在途订单实时进度表---新版.xlsx";

function isNumOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

describe.skipIf(!existsSync(FILE_A))("适配器④ 来源(a)：生产周期统计", () => {
  it(">400 行；待确认恰 37 行 → normalLeadDays=null（无 NaN）", async () => {
    const res = await leadtimeAdapter(FILE_A);
    const a = res.rows.filter((r) => r.payload.source === "sales_summary");
    expect(a.length).toBeGreaterThan(400);
    expect(res.stats.sourceARows).toBe(a.length);
    expect(res.stats.sourceANormalPendingConfirm).toBe(37);

    let nulls = 0;
    for (const r of a) {
      expect(isNumOrNull(r.payload.normalLeadDays)).toBe(true); // null 或有限数，NaN 必炸
      if (r.payload.normalLeadDays === null) nulls++;
      expect(typeof r.payload.skuCode).toBe("string");
    }
    expect(nulls).toBeGreaterThanOrEqual(37); // 至少覆盖全部「待确认」
  });
});

describe.skipIf(!existsSync(FILE_B))("适配器④ 来源(b)：生产周期明细（ooxml 通道）", () => {
  it(">400 行（基准 ~700）；moq/周期数值容错为 number|null", async () => {
    const res = await leadtimeAdapter(FILE_B);
    const b = res.rows.filter((r) => r.payload.source === "transit_progress");
    expect(b.length).toBeGreaterThan(400);
    expect(b.length).toBeLessThan(800); // 基准 ~700 的合理带
    for (const r of b) {
      expect(isNumOrNull(r.payload.moq)).toBe(true);
      expect(isNumOrNull(r.payload.normalLeadDays)).toBe(true);
      expect(isNumOrNull(r.payload.urgentLeadDays)).toBe(true);
      expect(typeof r.payload.skuCode).toBe("string");
    }
    // MOQ 至少部分为真实数值（非全「待确认」）
    expect(b.some((r) => typeof r.payload.moq === "number")).toBe(true);
  });
});

describe.skipIf(!existsSync(FILE_A) || !existsSync(FILE_B))("适配器④ 全链路（双文件同库）", () => {
  it("两来源各 stage >400 行；OEM 简码入 supplier_oem 异常队列", async () => {
    const { db } = await createTestDb();
    await seedDimensions(db);
    const [u] = await db.insert(schema.users).values({ name: "导入员" }).returning();

    const sumA = await stageLeadtime(db, FILE_A, u.id);
    const sumB = await stageLeadtime(db, FILE_B, u.id);
    expect(sumA.staged).toBeGreaterThan(400);
    expect(sumB.staged).toBeGreaterThan(400);

    expect((await getStagingRows(db, sumA.jobId)).length).toBe(sumA.staged + sumA.rejected);
    expect((await getStagingRows(db, sumB.jobId)).length).toBe(sumB.staged + sumB.rejected);

    const oemExc = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.aliasType, "supplier_oem"));
    expect(oemExc.length).toBeGreaterThan(0);
    // 同值跨文件只排队一次（UNIQUE(aliasType, rawValue)）
    const values = oemExc.map((e: { rawValue: string }) => e.rawValue);
    expect(new Set(values).size).toBe(values.length);
  });
});
