import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { loadTmallChannelContributionObservation } from "@/server/modules/report/tmall-channel-contribution";
import { createTestDb } from "../helpers/db";

const definitions = [
  ["tmall-sku-sales-observation", "jdy_tmall_sku_sales_observation", "sales"],
  ["tmall-sku-refund-observation", "jdy_tmall_sku_refund_observation", "refunds"],
  ["platform-fee-observation", "jdy_tmall_platform_fee_observation", "fees"],
] as const;

describe("天猫渠道金额贡献观察桥", () => {
  it("只连接三源同店铺完整月，缺失保持未知并单列费用孤岛", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "财务观察责任人" }).returning();
      const jobs = await db.insert(schema.importJobs).values(definitions.map(([stream]) => ({
        template: stream,
        filename: stream,
        sourceAsOf: "2026-08-13",
        createdBy: actor.id,
        status: "done" as const,
      }))).returning();
      await db.insert(schema.integrationRuns).values(definitions.map(([stream], index) => ({
        connector: "jdy",
        stream,
        idempotencyKey: `bridge-${stream}`,
        status: "succeeded" as const,
        importJobId: jobs[index].id,
        sourceRows: index === 0 || index === 2 ? 5 : 4,
        stagedRows: index === 0 || index === 2 ? 5 : 4,
        finishedAt: new Date("2026-08-13T09:00:00.000Z"),
      })));
      const payload = (statisticalDate: string, shopName: string, values: Record<string, string>) => ({
        data: { statisticalDate, shopName, ...values },
      });
      await db.insert(schema.stagingRows).values([
        // 销售：A 有完整月，B 缺费用；8 月只是部分月且含一条坏金额。
        { importJobId: jobs[0].id, rowNo: 1, status: "pending", targetTable: definitions[0][1], payload: payload("2026-06-30", "A店", { paidAmount: "500.00" }) },
        { importJobId: jobs[0].id, rowNo: 2, status: "pending", targetTable: definitions[0][1], payload: payload("2026-07-10", "A店", { paidAmount: "1000.00" }) },
        { importJobId: jobs[0].id, rowNo: 3, status: "pending", targetTable: definitions[0][1], payload: payload("2026-07-11", "B店", { paidAmount: "200.00" }) },
        { importJobId: jobs[0].id, rowNo: 4, status: "pending", targetTable: definitions[0][1], payload: payload("2026-08-12", "A店", { paidAmount: "300.00" }) },
        { importJobId: jobs[0].id, rowNo: 5, status: "pending", targetTable: definitions[0][1], payload: payload("2026-08-12", "A店", { paidAmount: "坏值" }) },
        // 退款。
        { importJobId: jobs[1].id, rowNo: 1, status: "pending", targetTable: definitions[1][1], payload: payload("2026-06-30", "A店", { successRefundAmount: "50.00" }) },
        { importJobId: jobs[1].id, rowNo: 2, status: "pending", targetTable: definitions[1][1], payload: payload("2026-07-12", "A店", { successRefundAmount: "100.00" }) },
        { importJobId: jobs[1].id, rowNo: 3, status: "pending", targetTable: definitions[1][1], payload: payload("2026-07-12", "B店", { successRefundAmount: "20.00" }) },
        { importJobId: jobs[1].id, rowNo: 4, status: "pending", targetTable: definitions[1][1], payload: payload("2026-08-12", "A店", { successRefundAmount: "30.00" }) },
        // 费用：C 店只有费用，不允许补销售/退款为 0；负数仍参与同符号合计。
        { importJobId: jobs[2].id, rowNo: 1, status: "pending", targetTable: definitions[2][1], payload: payload("2026-06-30", "A店", { paidAmount: "90.00", paidCurrency: "CNY" }) },
        { importJobId: jobs[2].id, rowNo: 2, status: "pending", targetTable: definitions[2][1], payload: payload("2026-07-15", "A店", { paidAmount: "210.00", paidCurrency: "CNY" }) },
        { importJobId: jobs[2].id, rowNo: 3, status: "pending", targetTable: definitions[2][1], payload: payload("2026-07-16", "A店", { paidAmount: "-10.00", paidCurrency: "CNY" }) },
        { importJobId: jobs[2].id, rowNo: 4, status: "pending", targetTable: definitions[2][1], payload: payload("2026-07-20", "C店", { paidAmount: "50.00", paidCurrency: "CNY" }) },
        { importJobId: jobs[2].id, rowNo: 5, status: "pending", targetTable: definitions[2][1], payload: payload("2026-08-12", "A店", { paidAmount: "60.00", paidCurrency: "CNY" }) },
      ]);

      const result = await loadTmallChannelContributionObservation(db);
      expect(result).toMatchObject({
        state: "preview",
        authority: "observation_only",
        latestClosedMonth: "2026-07",
        commonBusinessDateFrom: "2026-06-30",
        commonBusinessDateThrough: "2026-08-12",
        coverage: {
          closedShopMonths: 3,
          comparableShopMonths: 1,
          missingSalesShopMonths: 1,
          missingRefundShopMonths: 1,
          missingFeeShopMonths: 1,
          latestMonthComparableShops: 1,
          latestMonthTotalShops: 3,
        },
      });
      expect(result.sources.sales).toMatchObject({ validRows: 4, invalidRows: 1 });
      expect(result.monthly).toEqual([
        expect.objectContaining({
          month: "2026-07", comparableShops: 1, totalShops: 3,
          grossPaidAmount: "1000.00", successfulRefundAmount: "100.00",
          netCollectedObservation: "900.00", platformFeePaidAmount: "200.00",
          contributionBeforeProductCost: "700.00", refundAmountRatePct: "10.00",
          platformFeeRatePct: "22.22", excludedFeePaidAmount: "50.00",
        }),
      ]);
      expect(result.latestShops.find((row) => row.shopName === "B店")).toMatchObject({
        comparable: false,
        contributionBeforeProductCost: null,
        missingSources: ["fees"],
      });
      expect(result.latestShops.find((row) => row.shopName === "C店")).toMatchObject({
        comparable: false,
        platformFeePaidAmount: "50.00",
        missingSources: ["sales", "refunds"],
      });
    } finally {
      await client.close();
    }
  });

  it("缺任一成功来源批次时保持 insufficient，不把缺失当零", async () => {
    const { db, client } = await createTestDb();
    try {
      const result = await loadTmallChannelContributionObservation(db);
      expect(result.state).toBe("insufficient");
      expect(result.gate).toContain("缺少最新成功来源批次");
      expect(result.monthly).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
