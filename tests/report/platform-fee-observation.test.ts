import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { loadJiandaoyunPlatformFeeObservation } from "@/server/modules/report/platform-fee-observation";
import { createTestDb } from "../helpers/db";

describe("简道云天猫平台费用观察", () => {
  it("只读最新成功批次、按币种聚合并原样保留负数冲销", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "财务数据责任人" }).returning();
      const jobs = await db.insert(schema.importJobs).values([
        {
          template: "jdy_tmall_platform_fee_observation",
          filename: "old",
          sourceAsOf: "2026-07-31",
          createdBy: actor.id,
          status: "done",
        },
        {
          template: "jdy_tmall_platform_fee_observation",
          filename: "latest",
          sourceAsOf: "2026-08-12",
          createdBy: actor.id,
          status: "done",
        },
      ]).returning();
      const [oldJob, latestJob] = jobs;
      await db.insert(schema.integrationRuns).values([
        {
          connector: "jdy",
          stream: "platform-fee-observation",
          idempotencyKey: "old-fee",
          status: "succeeded",
          importJobId: oldJob.id,
          sourceRows: 1,
          stagedRows: 1,
          finishedAt: new Date("2026-08-01T01:00:00.000Z"),
        },
        {
          connector: "jdy",
          stream: "platform-fee-observation",
          idempotencyKey: "latest-fee",
          status: "succeeded",
          importJobId: latestJob.id,
          sourceRows: 4,
          stagedRows: 4,
          finishedAt: new Date("2026-08-13T01:00:00.000Z"),
        },
      ]);
      await db.insert(schema.stagingRows).values([
        {
          importJobId: oldJob.id,
          rowNo: 1,
          status: "pending",
          targetTable: "jdy_tmall_platform_fee_observation",
          payload: { data: { statisticalDate: "2026-07-01", shopName: "旧店", feeItem: "旧费用", billingCurrency: "CNY", billingAmount: "999", paidCurrency: "CNY", paidAmount: "999" } },
        },
        {
          importJobId: latestJob.id,
          rowNo: 1,
          status: "pending",
          targetTable: "jdy_tmall_platform_fee_observation",
          payload: { data: { statisticalDate: "2026-08-01", shopName: "旗舰店", feeItem: "平台服务费", billingCurrency: "CNY", billingAmount: "100.00", paidCurrency: "CNY", paidAmount: "90.00" } },
        },
        {
          importJobId: latestJob.id,
          rowNo: 2,
          status: "pending",
          targetTable: "jdy_tmall_platform_fee_observation",
          payload: { data: { statisticalDate: "2026-08-02", shopName: "旗舰店", feeItem: "退费冲销", billingCurrency: "CNY", billingAmount: "-10.00", paidCurrency: "CNY", paidAmount: "-8.00" } },
        },
        {
          importJobId: latestJob.id,
          rowNo: 3,
          status: "pending",
          targetTable: "jdy_tmall_platform_fee_observation",
          payload: { data: { statisticalDate: "2026-08-03", shopName: "旗舰店", feeItem: "坏值", billingCurrency: "CNY", billingAmount: "5", paidCurrency: "CNY", paidAmount: "不是数字" } },
        },
        {
          importJobId: latestJob.id,
          rowNo: 4,
          status: "pending",
          targetTable: "jdy_tmall_platform_fee_observation",
          payload: { data: { statisticalDate: "2026-08-04", shopName: "旗舰店", feeItem: "币种不一致", billingCurrency: "CNY", billingAmount: "2", paidCurrency: "USD", paidAmount: "2" } },
        },
      ]);

      const result = await loadJiandaoyunPlatformFeeObservation(db, {
        NODE_ENV: "test",
        JIANDAOYUN_SYNC_CONTRACTS: "platform-fee-observation",
      });

      expect(result).toMatchObject({
        state: "preview",
        authority: "observation_only",
        platform: "天猫",
        sourceAsOf: "2026-08-12",
        businessDateFrom: "2026-08-01",
        businessDateThrough: "2026-08-02",
        selectedForSync: true,
        totals: { sourceRows: 4, stagedRows: 4, validRows: 2, invalidRows: 2 },
        quality: { invalidPaidAmountRows: 1, currencyMismatchRows: 1 },
      });
      expect(result.currencies).toEqual([expect.objectContaining({
        currency: "CNY",
        rows: 2,
        billingAmount: "90.00",
        paidAmount: "82.00",
        billingPaidDelta: "-8.00",
        positivePaidAmount: "90.00",
        reversalPaidAmount: "-8.00",
        negativeRows: 1,
      })]);
      expect(result.monthly).toEqual([expect.objectContaining({ key: "2026-08", paidAmount: "82.00" })]);
      expect(result.feeItems.map((row) => row.key)).toEqual(["平台服务费", "退费冲销"]);
      expect(result.shops).toEqual([expect.objectContaining({ key: "旗舰店", paidAmount: "82.00" })]);
      expect(JSON.stringify(result)).not.toContain("999.00");
    } finally {
      await client.close();
    }
  });

  it("缺成功批次时不把平台费用伪装成零", async () => {
    const { db, client } = await createTestDb();
    try {
      const result = await loadJiandaoyunPlatformFeeObservation(db, { NODE_ENV: "test" });
      expect(result.state).toBe("insufficient");
      expect(result.gate).toContain("不得把缺失费用当作零");
      expect(result.selectedForSync).toBe(false);
    } finally {
      await client.close();
    }
  });
});
