/**
 * rt4 审计验证①：releaseSalesMonthly 同键覆盖丢量。
 * 两个不同 channelRaw（渠道别名变体，populate-stage CH_MAP 明确将
 * 抖音商品卡/抖音运营部 都认领到 douyin）落到同一 (sku,channel,yearMonth) 键时，
 * 引擎按「后行覆盖」而非累加——先行的销量被静默丢弃，且两行 staging 都翻 committed。
 * 对照：releaseSnapshots 对同键是累加（e.qty += p.qty），口径不一致。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import { releaseSalesMonthly, type ReleaseUser } from "@/server/modules/release/engine";

const pmc: ReleaseUser = { id: 1, name: "放行员", roles: ["pmc"], isApprover: false };

describe("rt4: releaseSalesMonthly 渠道别名归并导致同键覆盖", () => {
  it("同 SKU 同月两条不同 channelRaw 认领到同一渠道：后行覆盖前行，100 件销量被静默丢弃", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(schema.spus).values({ code: "P00001", nameCn: "洁面乳" }).returning();
    const [sku] = await db
      .insert(schema.skus)
      .values({ code: "N006-a", name: "洁面乳", spuId: spu.id, skuType: "finished", baseUom: "件" })
      .returning();
    const [ch] = await db
      .insert(schema.channels)
      .values({ code: "douyin", name: "抖音", kind: "platform" })
      .returning();
    // populate-stage.ts CH_MAP 的真实认领结果：两个原值 → 同一渠道
    await db.insert(schema.aliases).values([
      { aliasType: "channel", rawValue: "抖音商品卡", targetId: ch.id },
      { aliasType: "channel", rawValue: "抖音运营部", targetId: ch.id },
    ]);

    const [job] = await db
      .insert(schema.importJobs)
      .values({ template: "test", filename: "t.xlsx", status: "done", createdBy: 1 })
      .returning({ id: schema.importJobs.id });
    await writeStagingRows(db, job.id, [
      {
        rowNo: 1,
        targetTable: "sales_monthly",
        payload: { skuCode: "N006-a", yearMonth: "2026-01", channelRaw: "抖音商品卡", qty: 100 },
      },
      {
        rowNo: 2,
        targetTable: "sales_monthly",
        payload: { skuCode: "N006-a", yearMonth: "2026-01", channelRaw: "抖音运营部", qty: 50 },
      },
    ]);

    const res = await releaseSalesMonthly(pmc, { dryRun: false }, db);
    expect(res.blocked).toBe(0);

    const rows = await db.select().from(schema.salesMonthly);
    expect(rows).toHaveLength(1);
    expect(rows[0].skuId).toBe(sku.id);
    // 缺陷证明：真实月销应为 150（两条渠道变体各自的量），落库却只剩后一行的 50
    expect(Number(rows[0].qty)).toBe(150); // RT4-F2 修复后：同键聚合（dAdd），销量不丢

    // 且两条 staging 行都 committed（无任何阻塞/告警痕迹）——丢量完全静默
    const staged = await db.select().from(schema.stagingRows);
    expect(staged.every((r) => r.status === "committed")).toBe(true);
  });
});
