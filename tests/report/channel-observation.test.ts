/**
 * 全渠道外部观察：三平台各自锚定近 30 天，件数/金额口径分别保留；缺流 = insufficient 不补零；
 * 天猫宝贝损益给出 Top/Bottom 净利。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeChannelObservation, loadChannelObservation } from "@/server/modules/report/channel-observation";

describe("全渠道外部观察", () => {
  it("质量阻断的成功批次不得进入读模型", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "质量闸责任人" }).returning();
      const [job] = await db.insert(schema.importJobs).values({
        template: "jdy_pdd_order_observation", filename: "quality-blocked", sourceAsOf: "2026-09-03",
        createdBy: actor.id, status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values({
        connector: "jdy", stream: "pdd-order-observation", idempotencyKey: "quality-blocked",
        status: "succeeded", importJobId: job.id, requestScope: { qualityBlocked: true },
        finishedAt: new Date("2026-09-03T03:00:00.000Z"),
      });
      await db.insert(schema.stagingRows).values({
        importJobId: job.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_order_observation",
        payload: { data: { statisticalDate: "2026-09-02", shopName: "阻断店", orderNumber: "B1", productId: "P1", productQuantity: "999", orderStatus: "待发货" } },
      });
      const observation = await computeChannelObservation(db);
      expect(observation.platforms.find((row) => row.platform === "拼多多")).toMatchObject({ state: "insufficient", units: null });
    } finally {
      await client.close();
    }
  });

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
        { importJobId: sales.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_sales_observation", payload: { data: { statisticalDate: "2026-09-01", shopName: tShop, skuId: "P1", paidNumber: "10", paidAmount: "1000.505" } } },
        { importJobId: sales.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_sales_observation", payload: { data: { statisticalDate: "2026-06-01", shopName: tShop, skuId: "P1", paidNumber: "99", paidAmount: "9999" } } }, // 窗口外
        { importJobId: refunds.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_refund_observation", payload: { data: { statisticalDate: "2026-08-30", shopName: tShop, skuId: "P1", successRefundSuborderNumber: "2" } } },
        { importJobId: refunds.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_refund_observation", payload: { data: { statisticalDate: "2026-09-02", shopName: tShop, skuId: "P1", successRefundSuborderNumber: "50" } } },
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
      expect(tmall.amount).toBe("1000.51"); // 十进制定点半进位；不得经 Number 把 .005 舍掉
      expect(tmall.refundUnits).toBe(2); // 销售锚点之后的退款不能混入本窗口
      expect(tmall.byBrand[0]).toEqual({ brand: "NING", units: 8, amount: "1000.51" });
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
      const [brand] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P-PDD-BRAND", nameCn: "拼多多品牌归属" }).returning();
      const [sku] = await db.insert(schema.skus).values({
        code: "PDD-BRAND-001", name: "拼多多品牌归属成品", spuId: spu.id,
        skuType: "finished", baseUom: "支", brandId: brand.id,
      }).returning();
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
        shopName: "不含品牌名称的多品牌店",
        productId: "PID1",
        merchantSkuCode: "NING-001",
      };
      await db.insert(schema.skuIdentifiers).values({
        skuId: sku.id, kind: "external", scope: "JIANDAOYUN:PDD",
        value: `${base.shopName}|${base.productId}|${base.merchantSkuCode}`,
        active: true, isPrimary: false, createdBy: actor.id,
      });
      await db.insert(schema.stagingRows).values([
        { importJobId: job.id, rowNo: 1, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { ...base, orderNumber: "O1", productQuantity: "4", orderStatus: "已发货", afterSalesStatus: "" } } },
        { importJobId: job.id, rowNo: 2, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { ...base, orderNumber: "O2", productQuantity: "9", orderStatus: "已发货", afterSalesStatus: "退款成功" } } },
        { importJobId: job.id, rowNo: 3, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { ...base, orderNumber: "O3", productQuantity: "7", orderStatus: "已取消", afterSalesStatus: "" } } },
        { importJobId: job.id, rowNo: 4, status: "pending", targetTable: "jdy_pdd_order_observation", payload: { data: { ...base, orderNumber: "O4", productQuantity: "100", orderStatus: "待付款", afterSalesStatus: "", paymentTime: "" } } },
      ]);

      const observation = await computeChannelObservation(db);
      const pdd = observation.platforms.find((row) => row.platform === "拼多多")!;
      expect(pdd.state).toBe("ready");
      expect(pdd.units).toBe(4);
      expect(pdd.byBrand).toEqual([{ brand: "NING", units: 4, amount: null }]);
    } finally {
      await client.close();
    }
  });

  it("停用天猫直接认领会改变缓存绑定并立即移除旧品牌归属", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "认领缓存责任人" }).returning();
      const [brand] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P-CACHE", nameCn: "缓存验证商品" }).returning();
      const [sku] = await db.insert(schema.skus).values({
        code: "CACHE-001",
        name: "缓存验证成品",
        spuId: spu.id,
        skuType: "finished",
        baseUom: "支",
        brandId: brand.id,
      }).returning();
      const [job] = await db.insert(schema.importJobs).values({
        template: "jdy_tmall_sku_sales_observation",
        filename: "tmall-cache-sales",
        sourceAsOf: "2026-09-02",
        createdBy: actor.id,
        status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values({
        connector: "jdy",
        stream: "tmall-sku-sales-observation",
        idempotencyKey: "tmall-cache-sales",
        status: "succeeded",
        importJobId: job.id,
        finishedAt: new Date("2026-09-02T03:00:00.000Z"),
      });
      const shop = "不含品牌名称的测试店";
      await db.insert(schema.stagingRows).values({
        importJobId: job.id,
        rowNo: 1,
        status: "pending",
        targetTable: "jdy_tmall_sku_sales_observation",
        payload: { data: { statisticalDate: "2026-09-01", shopName: shop, skuId: "PSKU-CACHE", paidNumber: "5", paidAmount: "100" } },
      });
      const [identifier] = await db.insert(schema.skuIdentifiers).values({
        skuId: sku.id,
        kind: "external",
        scope: "JIANDAOYUN:TMALL",
        value: `${shop}|PSKU-CACHE`,
        createdBy: actor.id,
      }).returning();

      const mapped = await loadChannelObservation(db);
      expect(mapped.platforms.find((row) => row.platform === "天猫")?.byBrand[0]?.brand).toBe("NING");
      await db.update(schema.skuIdentifiers)
        .set({ active: false, updatedAt: new Date("2026-09-03T00:00:00.000Z") })
        .where(eq(schema.skuIdentifiers.id, identifier.id));
      const deactivated = await loadChannelObservation(db);
      expect(deactivated.platforms.find((row) => row.platform === "天猫")?.byBrand[0]?.brand).toBe("(未归属)");
    } finally {
      await client.close();
    }
  });
});

describe("第四阶段：天猫流量先行指标 + SKU 级毛利（2026-09-03）", () => {
  it("近 7 天 vs 前 7 天访客环比、支付转化；SKU 毛利按关联货品映射到系统 SKU 与品牌", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "外部数据责任人" }).returning();
      const [ning] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING", nameEn: "NING" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P90009", nameCn: "毛利测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "N009-000", name: "泥膜", spuId: spu.id, skuType: "finished", baseUom: "支", brandId: ning.id }).returning();
      const [trafficJob, costJob] = await db.insert(schema.importJobs).values([
        { template: "jdy_tmall_product_traffic_observation", filename: "t", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_cost_pnl_observation", filename: "c", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
      ]).returning();
      const finishedAt = new Date("2026-09-03T03:00:00.000Z");
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-product-traffic-observation", idempotencyKey: "t", status: "succeeded", importJobId: trafficJob.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-cost-pnl-observation", idempotencyKey: "c", status: "succeeded", importJobId: costJob.id, finishedAt },
      ]);
      const shop = "(天猫国际)NING海外旗舰店";
      const t = (rowNo: number, date: string, pid: string, visitors: string, buyers: string, amt: string) => ({
        importJobId: trafficJob.id, rowNo, status: "pending" as const, targetTable: "jdy_tmall_product_traffic_observation",
        payload: { data: { statisticalDate: date, shopName: shop, productId: pid, productName: `商品${pid}`, visitors, paidBuyers: buyers, paidAmount: amt, addonPeople: "1", collections: "2" } },
      });
      await db.insert(schema.stagingRows).values([
        // 商品 A：近 7 天 300 访客（前 7 天 100）→ 上升；商品 B：近 7 天 50（前 7 天 200）→ 下滑
        t(1, "2026-09-02", "A", "200", "10", "1000"), t(2, "2026-08-30", "A", "100", "5", "500"), t(3, "2026-08-25", "A", "100", "1", "100"),
        t(4, "2026-09-01", "B", "50", "1", "50"), t(5, "2026-08-24", "B", "200", "4", "400"),
        t(6, "2026-08-01", "A", "9999", "9", "9"), // 14 天外，不计
        { importJobId: costJob.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_cost_pnl_observation",
          payload: { data: { statisticalDate: "2026-09-01", shopName: shop, skuId: "S1", relatedGoods: "N009-000", paidAmount: "1000", refundAmount: "100", goodsCostSubtotal: "400", paidNumber: "10" } } },
        { importJobId: costJob.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_cost_pnl_observation",
          payload: { data: { statisticalDate: "2026-08-20", shopName: shop, skuId: "S2", relatedGoods: "UNKNOWN", paidAmount: "200", refundAmount: "0", goodsCostSubtotal: "300", paidNumber: "2" } } },
        { importJobId: costJob.id, rowNo: 3, status: "pending", targetTable: "jdy_tmall_sku_cost_pnl_observation",
          payload: { data: { statisticalDate: "2026-06-01", shopName: shop, skuId: "S1", relatedGoods: "N009-000", paidAmount: "99999", refundAmount: "0", goodsCostSubtotal: "0", paidNumber: "1" } } }, // 窗口外
      ]);
      const obs = await computeChannelObservation(db);
      expect(obs.traffic.state).toBe("ready");
      expect(obs.traffic.anchorDate).toBe("2026-09-02");
      expect(obs.traffic.totals.visitors7).toBe(350);
      expect(obs.traffic.totals.visitorsPrev7).toBe(300);
      expect(obs.traffic.totals.paidAmount7).toBe("1550.00");
      expect(obs.traffic.rising[0]?.productId).toBe("A");
      expect(obs.traffic.rising[0]?.visitorDelta).toBe(200);
      expect(obs.traffic.falling[0]?.productId).toBe("B");
      expect(obs.traffic.rising[0]?.conversion7).toBe(5);
      expect(obs.skuMargin.state).toBe("ready");
      expect(obs.skuMargin.totals.paidAmount).toBe("1200.00");
      expect(obs.skuMargin.totals.margin).toBe("400.00"); // (1000-100-400) + (200-0-300)
      expect(obs.skuMargin.totals.mappedSkus).toBe(1);
      expect(obs.skuMargin.top[0]?.systemSkuCode).toBe(sku.code);
      expect(obs.skuMargin.top[0]?.brand).toBe("NING");
      expect(obs.skuMargin.bottom[0]?.platformSkuId).toBe("S2");
      expect(obs.skuMargin.byBrand.find((b) => b.brand === "NING")?.marginPct).toBe(55.6);
    } finally {
      await client.close();
    }
  });
});

describe("平台日快照的 review 批次（业务键重复）不整批丢弃，读模型按业务键去重", () => {
  it("流量批次因 2 行重复被标 review：仍进入读模型且重复行只计一次；数值非法的 review 批次仍不用", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "外部数据责任人" }).returning();
      const [dupJob, badJob] = await db.insert(schema.importJobs).values([
        { template: "jdy_tmall_product_traffic_observation", filename: "t", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_cost_pnl_observation", filename: "c", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
      ]).returning();
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-product-traffic-observation", idempotencyKey: "t-dup", status: "succeeded", importJobId: dupJob.id, finishedAt: new Date("2026-09-03T03:00:00.000Z"),
          requestScope: { qualityBlocked: true, controlSummary: { status: "review", duplicateRows: 2, duplicateKeyGroups: 1, invalidNumericValues: 0, reconciliationMismatchedRows: 0, deletedRows: 0 } } },
        { connector: "jdy", stream: "tmall-sku-cost-pnl-observation", idempotencyKey: "c-bad", status: "succeeded", importJobId: badJob.id, finishedAt: new Date("2026-09-03T03:00:00.000Z"),
          requestScope: { qualityBlocked: true, controlSummary: { status: "review", duplicateRows: 0, invalidNumericValues: 3, reconciliationMismatchedRows: 0, deletedRows: 0 } } },
      ]);
      const shop = "(天猫国际)NING海外旗舰店";
      await db.insert(schema.stagingRows).values([
        { importJobId: dupJob.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_product_traffic_observation", payload: { data: { statisticalDate: "2026-09-02", shopName: shop, productId: "A", visitors: "100", paidBuyers: "5", paidAmount: "500" } } },
        { importJobId: dupJob.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_product_traffic_observation", payload: { data: { statisticalDate: "2026-09-02", shopName: shop, productId: "A", visitors: "100", paidBuyers: "5", paidAmount: "500" } } }, // 重复上传
        { importJobId: badJob.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_cost_pnl_observation", payload: { data: { statisticalDate: "2026-09-02", shopName: shop, skuId: "S1", paidAmount: "100", refundAmount: "0", goodsCostSubtotal: "10", paidNumber: "1" } } },
      ]);
      const obs = await computeChannelObservation(db);
      expect(obs.traffic.state).toBe("ready");
      expect(obs.traffic.totals.visitors7).toBe(100);
      expect(obs.traffic.totals.paidAmount7).toBe("500.00");
      expect(obs.skuMargin.state).toBe("insufficient");
    } finally {
      await client.close();
    }
  });
});
