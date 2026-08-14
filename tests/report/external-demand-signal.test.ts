import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  buildRollingDemandBrief,
  loadJiandaoyunExternalDemandSignal,
  refreshJiandaoyunExternalDemandReadModel,
} from "@/server/modules/report/external-demand-signal";
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
        { template: "jst_daily_sales", filename: "jst-outbound", sourceAsOf: "2026-08-10", createdBy: actor.id, status: "done" },
      ]).returning();
      const [oldSales, crosswalk, sales, refunds, jstOutbound] = jobs;
      const finishedAt = new Date("2026-08-11T03:00:00.000Z");
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "old-sales", status: "succeeded", importJobId: oldSales.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "crosswalk", status: "succeeded", importJobId: crosswalk.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "sales", status: "succeeded", importJobId: sales.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "refunds", status: "succeeded", importJobId: refunds.id, finishedAt },
        { connector: "jst", stream: "outbound-sales-daily", idempotencyKey: "jst-outbound", status: "succeeded", importJobId: jstOutbound.id, finishedAt },
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
        {
          importJobId: jstOutbound.id, rowNo: 1, status: "validated",
          targetTable: "jst_daily_sales",
          payload: { bizDate: "2026-08-10", skuCode: "JST-P1", qty: "88", _resolved: { skuId: 101 } },
        },
        {
          importJobId: jstOutbound.id, rowNo: 2, status: "validated",
          targetTable: "jst_daily_sales",
          payload: { bizDate: "2026-08-10", skuCode: "JST-ONLY", qty: "7", _resolved: { skuId: 202 } },
        },
      ]);
      await db.insert(schema.aliasExceptions).values({
        aliasType: "sku_barcode",
        scope: "JIANDAOYUN",
        rawValue: "690000000002",
        context: { connector: "jdy", field: "barcode" },
        status: "open",
      });

      const rebuilt = await refreshJiandaoyunExternalDemandReadModel(db);
      expect(rebuilt.state).toBe("ready");
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
        mappedPaidQty: 100,
        mappedRefundQty: 10,
        mappedNetQty: 90,
      });
      expect(result.decisionBrief.state).toBe("insufficient");
      expect(result.decisionBrief.gate).toContain("1/7 天");
      expect(result.quality.invalidSalesRows).toBe(1);
      expect(result.fulfillment).toMatchObject({
        state: "ready",
        jstSourceAsOf: "2026-08-10",
        totals: {
          comparableDemandQty: 90,
          comparableOutboundQty: 88,
          gapQty: -2,
          absoluteGapQty: 2,
        },
        coverage: {
          jdyMappedSkuDays: 1,
          jstMappedSkuDays: 2,
          comparableSkuDays: 1,
          jdyComparablePct: 100,
          jstComparablePct: 50,
        },
      });
      expect(result.fulfillment.daily[0]).toMatchObject({
        date: "2026-08-10",
        comparableDemandQty: 90,
        comparableOutboundQty: 88,
        gapQty: -2,
        onlyJstSkuDays: 1,
      });
      expect(result.fulfillment.topGaps[0]).toMatchObject({
        skuId: 101,
        mappedNetDemandQty: 90,
        jstOutboundQty: 88,
        gapQty: -2,
      });
      expect(result.gate).toContain("质量问题");
      expect(result.topUnmapped[0]).toMatchObject({
        platformSkuId: "P2",
        barcode: "690000000002",
        exceptionStatus: "open",
        netQty: 45,
      });
      expect(result.daily.some((row) => row.netQty === 999)).toBe(false);

      // 新批次一到，旧缓存的来源绑定立即失效；报表保持关闭而不是展示旧值。
      const [newSales] = await db.insert(schema.importJobs).values({
        template: "jdy_tmall_sku_sales_observation",
        filename: "new-sales-not-built",
        sourceAsOf: "2026-08-12",
        createdBy: actor.id,
        status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values({
        connector: "jdy",
        stream: "tmall-sku-sales-observation",
        idempotencyKey: "new-sales-not-built",
        status: "succeeded",
        importJobId: newSales.id,
        finishedAt: new Date("2026-08-12T03:00:00.000Z"),
      });
      const stale = await loadJiandaoyunExternalDemandSignal(db);
      expect(stale.state).toBe("insufficient");
      expect(stale.gate).toContain("BI 读模型尚未完成重建");
      expect(stale.sourceAsOf).toBe("2026-08-12");
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
      expect(result.fulfillment.state).toBe("insufficient");
    } finally {
      await client.close();
    }
  });

  it("只在两个自然日窗口均完整时生成最近7天对前7天的决策简报", () => {
    const rows = Array.from({ length: 14 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      const current = index >= 7;
      return {
        date: `2026-08-${day}`,
        sourceRows: 1,
        validPaidRows: 1,
        invalidSalesRows: 0,
        invalidRefundRows: 0,
        paidQty: current ? 20 : 10,
        refundQty: current ? 2 : 1,
        netQty: current ? 18 : 9,
        mappedPaidQty: current ? 12 : 5,
        mappedRefundQty: current ? 1 : 0.5,
        mappedNetQty: current ? 11 : 4.5,
      };
    });

    const result = buildRollingDemandBrief(rows);

    expect(result.state).toBe("ready");
    expect(result.anchorDate).toBe("2026-08-14");
    expect(result.previous).toMatchObject({
      startDate: "2026-08-01",
      endDate: "2026-08-07",
      observedDays: 7,
      paidQty: 70,
      netQty: 63,
      refundRatePct: 10,
      mappedPaidCoveragePct: 50,
    });
    expect(result.current).toMatchObject({
      startDate: "2026-08-08",
      endDate: "2026-08-14",
      observedDays: 7,
      paidQty: 140,
      netQty: 126,
      refundRatePct: 10,
      mappedPaidCoveragePct: 60,
    });
    expect(result.change).toEqual({
      paidQtyPct: 100,
      netQtyPct: 100,
      refundRateDeltaPp: 0,
      mappedPaidCoverageDeltaPp: 10,
    });
    expect(result.movement).toEqual({
      netDemand: "up",
      refundRate: "flat",
      mappedPaidCoverage: "up",
    });
  });

  it("缺日与零分母都保持未知，不把缺失或无法计算伪装成0", () => {
    const complete = Array.from({ length: 14 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      sourceRows: 1,
      validPaidRows: 1,
      invalidSalesRows: 0,
      invalidRefundRows: 0,
      paidQty: index >= 7 ? 1 : 0,
      refundQty: 0,
      netQty: index >= 7 ? 1 : 0,
      mappedPaidQty: 0,
      mappedRefundQty: 0,
      mappedNetQty: 0,
    }));
    const zeroBase = buildRollingDemandBrief(complete);
    expect(zeroBase.state).toBe("ready");
    expect(zeroBase.change.paidQtyPct).toBeNull();
    expect(zeroBase.change.netQtyPct).toBeNull();
    expect(zeroBase.previous.refundRatePct).toBeNull();
    expect(zeroBase.change.refundRateDeltaPp).toBeNull();

    const missingDay = buildRollingDemandBrief(complete.filter((row) => row.date !== "2026-08-03"));
    expect(missingDay.state).toBe("insufficient");
    expect(missingDay.previous.observedDays).toBe(6);
    expect(missingDay.change.netQtyPct).toBeNull();
    expect(missingDay.gate).toContain("缺失日不补零");
  });
});
