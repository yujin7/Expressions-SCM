import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { loadJiandaoyunExternalDemandSignal } from "@/server/modules/report/external-demand-signal";
import { createTestDb } from "../helpers/db";

describe("简道云外部需求信号", () => {
  it("只取各流最新成功批次、扣除退款，并显式报告身份与质量门禁", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "外部数据责任人" }).returning();
      const jobs = await db.insert(schema.importJobs).values([
        { template: "jdy_tmall_sku_sales_observation", filename: "old", sourceAsOf: "2026-08-09", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_crosswalk_observation", filename: "crosswalk", sourceAsOf: "2026-08-10", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_sales_observation", filename: "sales", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_refund_observation", filename: "refunds", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
      ]).returning();
      const [oldSales, crosswalk, sales, refunds] = jobs;
      const finishedAt = new Date("2026-08-11T03:00:00.000Z");
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "old-sales", status: "succeeded", importJobId: oldSales.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "crosswalk", status: "succeeded", importJobId: crosswalk.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "sales", status: "succeeded", importJobId: sales.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "refunds", status: "succeeded", importJobId: refunds.id, finishedAt },
      ]);
      await db.insert(schema.stagingRows).values([
        {
          importJobId: oldSales.id, rowNo: 1, status: "pending",
          targetTable: "jdy_tmall_sku_sales_observation",
          payload: { data: { statisticalDate: "2026-08-09", shopName: "旗舰店", skuId: "P1", paidNumber: "999" } },
        },
        {
          importJobId: crosswalk.id, rowNo: 1, status: "pending",
          targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: "旗舰店", platformSkuId: "P1" }, _identity: { skuId: 101 } },
        },
        {
          importJobId: crosswalk.id, rowNo: 2, status: "pending",
          targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: "旗舰店", platformSkuId: "P2", barcode: "690000000002" }, _identity: {} },
        },
        {
          importJobId: sales.id, rowNo: 1, status: "pending",
          targetTable: "jdy_tmall_sku_sales_observation",
          payload: { data: { statisticalDate: "2026-08-10T00:00:00.000Z", shopName: "旗舰店", skuId: "P1", skuName: "已映射", paidNumber: "100" } },
        },
        {
          importJobId: sales.id, rowNo: 2, status: "pending",
          targetTable: "jdy_tmall_sku_sales_observation",
          payload: { data: { statisticalDate: "2026-08-10", shopName: "旗舰店", skuId: "P2", skuName: "待认领", paidNumber: "50" } },
        },
        {
          importJobId: sales.id, rowNo: 3, status: "pending",
          targetTable: "jdy_tmall_sku_sales_observation",
          payload: { data: { statisticalDate: "2026-08-11", shopName: "旗舰店", skuId: "P3", paidNumber: "坏值" } },
        },
        {
          importJobId: refunds.id, rowNo: 1, status: "pending",
          targetTable: "jdy_tmall_sku_refund_observation",
          payload: { data: { statisticalDate: "2026-08-10", shopName: "旗舰店", skuId: "P1", successRefundSuborderNumber: "10" } },
        },
        {
          importJobId: refunds.id, rowNo: 2, status: "pending",
          targetTable: "jdy_tmall_sku_refund_observation",
          payload: { data: { statisticalDate: "2026-08-10", shopName: "旗舰店", skuId: "P2", successRefundSuborderNumber: "5" } },
        },
      ]);
      await db.insert(schema.aliasExceptions).values({
        aliasType: "sku_barcode",
        scope: "JIANDAOYUN",
        rawValue: "690000000002",
        context: { connector: "jdy", field: "barcode" },
        status: "open",
      });

      const result = await loadJiandaoyunExternalDemandSignal(db);

      expect(result.state).toBe("ready");
      expect(result.authority).toBe("observation_only");
      expect(result.sourceAsOf).toBe("2026-08-11");
      expect(result.totals).toMatchObject({
        paidQty: 150,
        refundQty: 15,
        netQty: 135,
        mappedPaidQty: 100,
        mappedRefundQty: 10,
        mappedNetQty: 90,
      });
      expect(result.coverage).toMatchObject({
        salesRows: 3,
        mappedSalesRows: 1,
        platformIdentities: 3,
        mappedIdentities: 1,
        identityPct: 33.3,
        paidQtyPct: 66.7,
      });
      expect(result.daily.find((row) => row.date === "2026-08-10")).toMatchObject({
        paidQty: 150,
        refundQty: 15,
        netQty: 135,
        mappedNetQty: 90,
      });
      expect(result.quality.invalidSalesRows).toBe(1);
      expect(result.gate).toContain("质量问题");
      expect(result.topUnmapped[0]).toMatchObject({
        platformSkuId: "P2",
        barcode: "690000000002",
        exceptionStatus: "open",
        netQty: 45,
      });
      expect(result.daily.some((row) => row.netQty === 999)).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("缺任一契约批次时不把缺失伪装成零", async () => {
    const { db, client } = await createTestDb();
    try {
      const result = await loadJiandaoyunExternalDemandSignal(db);
      expect(result.state).toBe("insufficient");
      expect(result.gate).toContain("缺少最新成功批次");
      expect(result.coverage.identityPct).toBeNull();
    } finally {
      await client.close();
    }
  });
});
