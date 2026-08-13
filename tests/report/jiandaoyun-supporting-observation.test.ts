import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { loadJiandaoyunSupportingObservations } from "@/server/modules/report/jiandaoyun-supporting-observation";
import { createTestDb } from "../helpers/db";

describe("简道云历史辅助洞察", () => {
  it("只聚合每条流最新成功批次，并保留历史观察边界", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "数据责任人" }).returning();
      const [oldDemand, latestDemand, countJob] = await db.insert(schema.importJobs).values([
        {
          template: "jdy_purchase_demand_observation",
          filename: "old-demand",
          sourceAsOf: "2024-01-31",
          createdBy: actor.id,
          status: "done",
        },
        {
          template: "jdy_purchase_demand_observation",
          filename: "latest-demand",
          sourceAsOf: "2024-12-11",
          createdBy: actor.id,
          status: "done",
        },
        {
          template: "jdy_inventory_count_observation",
          filename: "latest-count",
          sourceAsOf: "2024-07-22",
          createdBy: actor.id,
          status: "done",
        },
      ]).returning();
      await db.insert(schema.integrationRuns).values([
        {
          connector: "jdy",
          stream: "purchase-demand-observation",
          idempotencyKey: "old-demand",
          status: "succeeded",
          importJobId: oldDemand.id,
          sourceRows: 1,
          stagedRows: 1,
          finishedAt: new Date("2024-02-01T00:00:00.000Z"),
        },
        {
          connector: "jdy",
          stream: "purchase-demand-observation",
          idempotencyKey: "latest-demand",
          status: "succeeded",
          importJobId: latestDemand.id,
          sourceRows: 2,
          stagedRows: 2,
          finishedAt: new Date("2024-12-11T00:00:00.000Z"),
        },
        {
          connector: "jdy",
          stream: "inventory-count-observation",
          idempotencyKey: "latest-count",
          status: "succeeded",
          importJobId: countJob.id,
          sourceRows: 2,
          stagedRows: 2,
          finishedAt: new Date("2024-07-22T00:00:00.000Z"),
        },
      ]);
      await db.insert(schema.aliases).values([
        {
          aliasType: "sku_code",
          scope: "JIANDAOYUN",
          rawValue: "SKU-SECRET-A",
          targetId: 1,
          createdBy: actor.id,
        },
        {
          aliasType: "sku_code",
          scope: "GLOBAL",
          rawValue: "SKU-SECRET-B",
          targetId: 2,
          createdBy: actor.id,
        },
      ]);
      await db.insert(schema.stagingRows).values([
        {
          importJobId: oldDemand.id,
          rowNo: 1,
          status: "pending",
          targetTable: "jdy_purchase_demand_observation",
          payload: { data: { requestedAt: "2024-01-01", requestedQty: "999", purchasedQty: "999", purchaseStatus: "已采购", skuCode: "OLD-SECRET" } },
        },
        {
          importJobId: latestDemand.id,
          rowNo: 1,
          status: "pending",
          targetTable: "jdy_purchase_demand_observation",
          payload: { data: { requestedAt: "2024-11-01", requestedQty: "100", purchasedQty: "80", purchaseStatus: "部分采购", productCode: "ＳＫＵ－ＳＥＣＲＥＴ－Ａ" } },
        },
        {
          importJobId: latestDemand.id,
          rowNo: 2,
          status: "validated",
          targetTable: "jdy_purchase_demand_observation",
          payload: { data: { requestedAt: "2024-12-10", requestedQty: "20.5", purchasedQty: "0", purchaseStatus: "未采购", productCode: "SKU-SECRET-B", supplier: "供应商秘密" } },
        },
        {
          importJobId: countJob.id,
          rowNo: 1,
          status: "pending",
          targetTable: "jdy_inventory_count_observation",
          payload: { data: { startedAt: "2024-07-20", finishedAt: "2024-07-21", lossQty: "3", gainQty: "0", warehouse: "仓库秘密" } },
        },
        {
          importJobId: countJob.id,
          rowNo: 2,
          status: "committed",
          targetTable: "jdy_inventory_count_observation",
          payload: { data: { startedAt: "2024-07-21", finishedAt: "2024-07-22", lossQty: "0", gainQty: "5" } },
        },
      ]);

      const result = await loadJiandaoyunSupportingObservations(db);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        stream: "purchase-demand-observation",
        authority: "historical_observation",
        importJobId: latestDemand.id,
        sourceAsOf: "2024-12-11",
        businessDateFrom: "2024-11-01",
        businessDateThrough: "2024-12-10",
        rows: 2,
        summary: "需求行 2行 · 需求数量 120.5 · 已采购数量 80 · 未/部分采购 2行",
        identityCoverage: expect.arrayContaining([{
          kind: "sku_code",
          label: "SKU 身份",
          distinctValues: 2,
          governedMatches: 1,
          openValues: 1,
        }, {
          kind: "supplier",
          label: "供应商身份",
          distinctValues: 1,
          governedMatches: 0,
          openValues: 1,
        }]),
      });
      expect(result[0].metrics).toEqual([
        { key: "rows", label: "需求行", value: "2", unit: "行" },
        { key: "requested", label: "需求数量", value: "120.5000", unit: "" },
        { key: "purchased", label: "已采购数量", value: "80.0000", unit: "" },
        { key: "open", label: "未/部分采购", value: "2", unit: "行" },
      ]);
      expect(result[1]).toMatchObject({
        stream: "inventory-count-observation",
        businessDateFrom: "2024-07-20",
        businessDateThrough: "2024-07-22",
        rows: 2,
        summary: "盘点单 2单 · 盘亏数量 3 · 盘盈数量 5 · 有差异盘点 2单",
        identityCoverage: [{
          kind: "warehouse",
          label: "仓库身份",
          distinctValues: 1,
          governedMatches: 0,
          openValues: 1,
        }],
      });
      expect(result.every((row) => row.gate.includes("JIANDAOYUN 作用域人工认领"))).toBe(true);
      expect(result.every((row) => row.gate.includes("不参与产品放行"))).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("999");
      expect(serialized).not.toContain("SKU-SECRET");
      expect(serialized).not.toContain("ＳＫＵ－ＳＥＣＲＥＴ");
      expect(serialized).not.toContain("供应商秘密");
      expect(serialized).not.toContain("仓库秘密");
    } finally {
      await client.close();
    }
  });

  it("缺成功批次时保持缺失，不伪装成零", async () => {
    const { db, client } = await createTestDb();
    try {
      await expect(loadJiandaoyunSupportingObservations(db)).resolves.toEqual([]);
    } finally {
      await client.close();
    }
  });
});
