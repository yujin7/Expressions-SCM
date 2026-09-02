/**
 * 全渠道外部观察：三平台各自锚定近 30 天，件数/金额口径分别保留；缺流 = insufficient 不补零；
 * 天猫宝贝损益给出 Top/Bottom 净利。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeChannelObservation, loadChannelObservation } from "@/server/modules/report/channel-observation";

describe("全渠道外部观察", () => {
  it("三平台按各自锚点汇总近 30 天；缺流保持 insufficient；损益给出正负两端", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "外部数据责任人" }).returning();
      await db.insert(schema.brands).values([{ code: "NING", nameCn: "NING", nameEn: "NING" }, { code: "DEV", nameCn: "DEVIANCE", nameEn: "DEVIANCE" }]);
      const jobs = await db.insert(schema.importJobs).values([
        { template: "jdy_tmall_sku_sales_observation", filename: "s", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_refund_observation", filename: "r", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
        { template: "jdy_vip_shop_trading_observation", filename: "v", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_product_pnl_observation", filename: "p", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
      ]).returning();
      const [sales, refunds, vip, pnl] = jobs;
      const finishedAt = new Date("2026-09-02T03:00:00.000Z");
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "s", status: "succeeded", importJobId: sales.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "r", status: "succeeded", importJobId: refunds.id, finishedAt },
        { connector: "jdy", stream: "vip-shop-trading-observation", idempotencyKey: "v", status: "succeeded", importJobId: vip.id, finishedAt },
        { connector: "jdy", stream: "tmall-product-pnl-observation", idempotencyKey: "p", status: "succeeded", importJobId: pnl.id, finishedAt },
      ]);
      const tShop = "(天猫国际)NING海外旗舰店";
      await db.insert(schema.stagingRows).values([
        { importJobId: sales.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_sales_observation", payload: { data: { statisticalDate: "2026-09-01", shopName: tShop, skuId: "P1", paidNumber: "10", paidAmount: "1000.50" } } },
        { importJobId: sales.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_sales_observation", payload: { data: { statisticalDate: "2026-06-01", shopName: tShop, skuId: "P1", paidNumber: "99", paidAmount: "9999" } } }, // 窗口外
        { importJobId: refunds.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_refund_observation", payload: { data: { statisticalDate: "2026-08-30", shopName: tShop, skuId: "P1", successRefundSuborderNumber: "2" } } },
        { importJobId: vip.id, rowNo: 1, status: "pending", targetTable: "jdy_vip_shop_trading_observation", payload: { data: { statisticalDate: "2026-08-20", shopName: "(唯品会)NING PTE. LTD.", brandName: "NING", salesAmount: "5000", salesQuantity: "40" } } },
        { importJobId: vip.id, rowNo: 2, status: "pending", targetTable: "jdy_vip_shop_trading_observation", payload: { data: { statisticalDate: "2026-08-21", shopName: "(唯品会)NING PTE. LTD.", brandName: "DEVIANCE", salesAmount: "1200", salesQuantity: "6" } } },
        { importJobId: pnl.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_product_pnl_observation", payload: { data: { statisticalDate: "2026-08-25", shopName: tShop, platformProductId: "PP1", productName: "赚钱的", actualTransactionAmount: "3000", totalSalesCost: "1000", estimatedGrossProfit: "2000", estimatedNetProfit: "1500", paidNumber: "30" } } },
        { importJobId: pnl.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_product_pnl_observation", payload: { data: { statisticalDate: "2026-08-26", shopName: tShop, platformProductId: "PP2", productName: "亏钱的", actualTransactionAmount: "500", totalSalesCost: "900", estimatedGrossProfit: "-400", estimatedNetProfit: "-450", paidNumber: "5" } } },
      ]);
      const o = await computeChannelObservation(db);
      expect(o.state).toBe("ready");
      const tmall = o.platforms.find((p) => p.platform === "天猫")!;
      expect(tmall.state).toBe("ready");
      expect(tmall.anchorDate).toBe("2026-09-01");
      expect(tmall.units).toBe(8);               // 10 − 2，窗口外的 99 不算
      expect(tmall.amount).toBe("1000.50");
      expect(tmall.byBrand[0]).toEqual({ brand: "NING", units: 8, amount: "1000.50" });
      const pdd = o.platforms.find((p) => p.platform === "拼多多")!;
      expect(pdd.state).toBe("insufficient");     // 未同步 → 不补零
      expect(pdd.units).toBeNull();
      const vipRow = o.platforms.find((p) => p.platform === "唯品会")!;
      expect(vipRow.units).toBe(46);
      expect(vipRow.amount).toBe("6200.00");
      expect(vipRow.byBrand.map((b) => b.brand)).toEqual(["NING", "DEV"]);
      expect(o.productPnl.state).toBe("ready");
      expect(o.productPnl.totals.estimatedNetProfit).toBe("1050.00");
      expect(o.productPnl.topNetProfit[0]?.productName).toBe("赚钱的");
      expect(o.productPnl.bottomNetProfit[0]?.productName).toBe("亏钱的");
      const cached = await loadChannelObservation(db);
      expect(cached.platforms.find((p) => p.platform === "天猫")?.units).toBe(8);
    } finally {
      await client.close();
    }
  });

  it("拼多多同时按订单状态和售后状态剔除取消与退款成功", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "拼多多观察责任人" }).returning();
      const [job] = await db.insert(schema.importJobs).values({
        template: "jdy_pdd_order_observation",
        filename: "pdd-orders",
        sourceAsOf: "2026-09-02",
        createdBy: actor.id,
        status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values({
        connector: "jdy",
        stream: "pdd-order-observation",
        idempotencyKey: "pdd-orders-status-test",
        status: "succeeded",
        importJobId: job.id,
        finishedAt: new Date("2026-09-02T03:00:00.000Z"),
      });
      const base = {
        statisticalDate: "2026-09-01",
        shopName: "(拼多多国际)NING官方海外旗舰店",
        productId: "PID1",
        merchantSkuCode: "NING-001",
      };
      await db.insert(schema.stagingRows).values([
        { importJobId: job.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { ...base, orderNumber: "O1", productQuantity: "4", orderStatus: "已发货", afterSalesStatus: "" } } },
        { importJobId: job.id, rowNo: 2, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { ...base, orderNumber: "O2", productQuantity: "9", orderStatus: "已发货", afterSalesStatus: "退款成功" } } },
        { importJobId: job.id, rowNo: 3, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { ...base, orderNumber: "O3", productQuantity: "7", orderStatus: "已取消", afterSalesStatus: "" } } },
      ]);

      const observation = await computeChannelObservation(db);
      const pdd = observation.platforms.find((row) => row.platform === "拼多多")!;
      expect(pdd.state).toBe("ready");
      expect(pdd.units).toBe(4);
    } finally {
      await client.close();
    }
  });
});
