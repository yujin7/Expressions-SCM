/**
 * 适配器③（26年产品销量汇总 → sales_monthly）——真实文件冒烟 + 全链路。
 *
 * 年度基准偏差（已事实核查，见 sales-monthly.ts 头注）：任务基准假定品牌页为
 * 2023/24 历史（年份横幅），实测年份横幅只在「汇总」页；品牌明细页为 2026 年
 * 1–6 月数据（总计行与汇总页 2026 段逐月一致）。故断言 yearMonth ∈ 2026-01..06，
 * 而非 /^20(23|24)-/。
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
  salesMonthlyAdapter,
  stageSalesMonthly,
} from "@/server/import/adapters/sales-monthly";

const FILE = "/Users/yj/Downloads/26年产品销量汇总（6月）.xlsx";

describe.skipIf(!existsSync(FILE))("适配器③：月销量长表化（真实文件）", () => {
  it("5 个品牌页；非零 SKU×渠道×月 >5,000 行；qty 全为非零有限数值", async () => {
    const res = await salesMonthlyAdapter(FILE);
    expect(res.stats.sheetsParsed).toBe(5);
    expect(res.rows.length).toBeGreaterThan(5000);
    for (const r of res.rows) {
      const qty = r.payload.qty as number;
      expect(typeof qty).toBe("number");
      expect(Number.isFinite(qty)).toBe(true);
      expect(qty).not.toBe(0);
    }
  });

  it("yearMonth 全部为 2026-01..2026-06（年度事实核查，偏离任务 2023/24 基准）", async () => {
    const res = await salesMonthlyAdapter(FILE);
    const months = new Set<string>();
    for (const r of res.rows) {
      const ym = r.payload.yearMonth as string;
      expect(ym).toMatch(/^2026-0[1-6]$/);
      months.add(ym);
    }
    expect(months.size).toBe(6); // 1–6 月每月都有数据
  });

  it("已知 SKU 抽查：E01-001-a（EXP 薰衣草按摩精油升级版）在结果中出现", async () => {
    const res = await salesMonthlyAdapter(FILE);
    const hits = res.rows.filter((r) => r.payload.skuCode === "E01-001-a");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].payload.brandSheet).toBe("EXP销量");
  });

  it("stage 全链路：渠道解析或排队不崩溃；渠道异常含标准渠道名与月度变体", async () => {
    const { db } = await createTestDb();
    await seedDimensions(db);
    const [u] = await db.insert(schema.users).values({ name: "导入员" }).returning();

    const sum = await stageSalesMonthly(db, FILE, u.id);
    expect(sum.staged).toBeGreaterThan(5000);
    expect(sum.staged).toBe(sum.validated + sum.pending);

    const staged = await getStagingRows(db, sum.jobId);
    expect(staged.length).toBe(sum.staged);

    // 渠道别名未种标准名（种子只有变体行）→ 全部排队；含 天猫 与 抖音运营部/北美TK 变体
    const chExc = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.aliasType, "channel"));
    const values = new Set(chExc.map((e: { rawValue: string }) => e.rawValue));
    expect(values.has("天猫")).toBe(true);
    expect(values.size).toBeGreaterThanOrEqual(10);
    expect(sum.unresolved.channel).toBe(values.size);
  });
});
