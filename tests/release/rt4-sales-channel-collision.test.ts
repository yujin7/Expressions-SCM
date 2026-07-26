/**
 * RT4-F2 回归保护：不同渠道原值归并到同一渠道后，必须按业务键聚合销量。
 * 两个 channelRaw（抖音商品卡/抖音运营部）都认领到 douyin，
 * 最终落到同一 (sku,channel,yearMonth) 键；放行必须累加，不能后写覆盖。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import { releaseSalesMonthly, type ReleaseUser } from "@/server/modules/release/engine";

const pmc: ReleaseUser = { id: 1, name: "放行员", roles: ["pmc"], isApprover: false };

describe("rt4: releaseSalesMonthly 渠道别名归并", () => {
  it("同 SKU 同月的渠道别名归并后聚合销量，不丢弃先行数据", async () => {
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
    // RT4-F2：两条渠道变体各自的量按同键聚合（dAdd）。
    expect(Number(rows[0].qty)).toBe(150);

    // 两条来源行都被同一聚合结果吸收并正确提交。
    const staged = await db.select().from(schema.stagingRows);
    expect(staged.every((r) => r.status === "committed")).toBe(true);
  });
});
