/**
 * SKU 外部销量排名（external-sku-ranking/v1）：只消费外部销速读模型（含 D47 组合装拆解），
 * 排名按近 30 天净件数；内部近 3 月对照走 core/velocity.lastMonths；筛选/导出用同一过滤函数；
 * 缓存绑定随外部销速绑定与 sales_monthly 变化。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeExternalSkuRanking, filterExternalSkuRanking, loadExternalSkuRanking } from "@/server/modules/report/external-sku-ranking";

describe("SKU 外部销量排名", () => {
  it("外部销速缺席时保持 insufficient，不补零", async () => {
    const { db, client } = await createTestDb();
    try {
      const model = await computeExternalSkuRanking(db);
      expect(model.state).toBe("insufficient");
      expect(model.rows).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("按近 30 天净件数排名；组合装按天猫组合表拆到组件；内部近 3 月并列；筛选与缓存", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "外部排名责任人" }).returning();
      const [ning, dev] = await db.insert(schema.brands).values([{ code: "NING", nameCn: "NING" }, { code: "DEV", nameCn: "DEVIANCE" }]).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P-RANK", nameCn: "排名测试" }).returning();
      const [channel] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" as never }).returning();
      const mk = async (code: string, brandId: number) => {
        const [row] = await db.insert(schema.skus).values({ code, name: `货品${code}`, spuId: spu.id, skuType: "finished", baseUom: "支", brandId }).returning();
        return row;
      };
      const a = await mk("RK-A", ning.id);   // 直接认领，30 天 10 − 2
      const b = await mk("RK-B", dev.id);    // 组合装组件：2 × 每份 → 30 天 6
      await mk("RK-C", dev.id);              // 组合装组件：1 × 每份 → 30 天 3
      await mk("RK-NONE", ning.id);          // 无外部身份，不进排名
      // 内部销量：最新月 2026-06 → 窗口 2026-04..06；a 有 2026-03（窗口外）与 2026-05
      await db.insert(schema.salesMonthly).values([
        { skuId: a.id, channelId: channel.id, yearMonth: "2026-03", qty: "999.0000" },
        { skuId: a.id, channelId: channel.id, yearMonth: "2026-05", qty: "40.0000" },
        { skuId: b.id, channelId: channel.id, yearMonth: "2026-06", qty: "5.5000" },
      ]);
      const [cw, sales, refunds, bundle] = await db.insert(schema.importJobs).values([
        { template: "jdy_tmall_sku_crosswalk_observation", filename: "cw", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_sales_observation", filename: "s", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_refund_observation", filename: "r", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_bundle_detail_observation", filename: "b", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
      ]).returning();
      const finishedAt = new Date("2026-09-02T03:00:00.000Z");
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "cw", status: "succeeded", importJobId: cw.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "s", status: "succeeded", importJobId: sales.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "r", status: "succeeded", importJobId: refunds.id, finishedAt },
        { connector: "jdy", stream: "tmall-bundle-detail-observation", idempotencyKey: "b", status: "succeeded", importJobId: bundle.id, finishedAt },
      ]);
      const shop = "NING旗舰店";
      await db.insert(schema.skuIdentifiers).values({ skuId: a.id, kind: "external", scope: "JIANDAOYUN:TMALL", value: `${shop}|P-A`, active: true, isPrimary: false, createdBy: actor.id });
      const sale = (rowNo: number, psku: string, date: string, paid: string) => ({
        importJobId: sales.id, rowNo, status: "pending" as const, targetTable: "jdy_tmall_sku_sales_observation",
        payload: { data: { statisticalDate: date, shopName: shop, skuId: psku, paidNumber: paid, paidAmount: "1" } },
      });
      await db.insert(schema.stagingRows).values([
        { importJobId: cw.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation", payload: { data: { shopName: shop, platformSkuId: "P-BUNDLE", merchantSkuCode: "combo2" }, _identity: {} } },
        { importJobId: bundle.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_bundle_detail_observation", payload: { data: { shopName: shop, productId: "G", bundleCode: "combo2", subproductId: "S1", subproductCode: "RK-B", quantity: "2" } } },
        { importJobId: bundle.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_bundle_detail_observation", payload: { data: { shopName: shop, productId: "G", bundleCode: "combo2", subproductId: "S2", subproductCode: "RK-C", quantity: "1" } } },
        sale(1, "P-A", "2026-09-01", "10"),
        sale(2, "P-BUNDLE", "2026-08-30", "3"),
        sale(3, "P-A", "2026-07-01", "50"), // 90 天内、30 天外
        { importJobId: refunds.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_refund_observation", payload: { data: { statisticalDate: "2026-08-31", shopName: shop, skuId: "P-A", successRefundSuborderNumber: "2" } } },
      ]);

      // 截止 8/31 的退款不能与 9/1 的销量计算净件数。
      expect(await computeExternalSkuRanking(db)).toMatchObject({ state: "insufficient", rows: [] });
      // 新证据作为新批次进入，不能原地修改已缓存的不可变来源批次。
      const [freshRefunds] = await db.insert(schema.importJobs).values({ template: "jdy_tmall_sku_refund_observation", filename: "r-fresh", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" }).returning();
      await db.insert(schema.integrationRuns).values({ connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "r-fresh", status: "succeeded", importJobId: freshRefunds.id, finishedAt: new Date("2026-09-02T04:00:00.000Z") });
      await db.insert(schema.stagingRows).values([
        { importJobId: freshRefunds.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_refund_observation", payload: { data: { statisticalDate: "2026-08-31", shopName: shop, skuId: "P-A", successRefundSuborderNumber: "2" } } },
        { importJobId: freshRefunds.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_refund_observation", payload: { data: { statisticalDate: "2026-09-01", shopName: shop, skuId: "P-A", successRefundSuborderNumber: "0" } } },
      ]);
      const model = await computeExternalSkuRanking(db);
      expect(model.state).toBe("ready");
      expect(model.anchorDate).toBe("2026-09-01");
      expect(model.internalMonths).toEqual(["2026-04", "2026-05", "2026-06"]);
      expect(model.rows.map((r) => [r.rank, r.code, r.net30, r.net90, r.internal3m])).toEqual([
        [1, "RK-A", "8.0000", "58.0000", 40],
        [2, "RK-B", "6.0000", "6.0000", 5.5],
        [3, "RK-C", "3.0000", "3.0000", 0],
      ]);
      expect(model.rows[0]).toMatchObject({ brand: "NING", tmallNet30: "8.0000", pddNet30: "0.0000", lastSoldDate: "2026-09-01", activeDays90: 2 });
      expect(model.rows.find((r) => r.code === "RK-NONE")).toBeUndefined();
      expect(model.brands).toEqual(["DEV", "NING"]);
      expect(model.coverage.bundlePlatformSkus).toBe(1);

      const onlyDev = filterExternalSkuRanking(model, { brand: "DEV" });
      expect(onlyDev.rows.map((r) => r.code)).toEqual(["RK-B", "RK-C"]);
      expect(onlyDev.totalRows).toBe(2);
      expect(filterExternalSkuRanking(model, { platform: "pdd" }).rows).toEqual([]);
      expect(filterExternalSkuRanking(model, { q: "rk-c" }).rows.map((r) => r.code)).toEqual(["RK-C"]);
      expect(filterExternalSkuRanking(model, { limit: 1 })).toMatchObject({ totalRows: 3 });
      expect(filterExternalSkuRanking(model, { limit: 1 }).rows).toHaveLength(1);

      // 缓存：第二次读取一致；内部事实新增一个月后绑定变化、内部对照随之更新
      const cached = await loadExternalSkuRanking(db);
      expect(cached.rows[0]?.net30).toBe("8.0000");
      await db.insert(schema.salesMonthly).values({ skuId: a.id, channelId: channel.id, yearMonth: "2026-07", qty: "7.0000" });
      const refreshed = await loadExternalSkuRanking(db);
      expect(refreshed.internalMonths).toEqual(["2026-05", "2026-06", "2026-07"]);
      expect(refreshed.rows[0]?.internal3m).toBe(47);
    } finally {
      await client.close();
    }
  });
});
