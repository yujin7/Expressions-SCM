import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { loadCommerceIdentityCoverage } from "@/server/modules/report/commerce-identity-coverage";
import { createTestDb } from "../helpers/db";

describe("简道云多平台商品身份覆盖", () => {
  it("按平台取最新成功批次，并分别暴露覆盖、重复、冲突和桥接字段", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "平台身份责任人" }).returning();
      const jobs = await db.insert(schema.importJobs).values([
        { template: "jdy_tmall_sku_crosswalk_observation", filename: "tmall-old", sourceAsOf: "2026-08-01", createdBy: actor.id, status: "done" },
        { template: "jdy_tmall_sku_crosswalk_observation", filename: "tmall", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
        { template: "jdy_pdd_sku_crosswalk_observation", filename: "pdd", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
        { template: "jdy_vip_product_crosswalk_observation", filename: "vip", sourceAsOf: "2026-08-11", createdBy: actor.id, status: "done" },
      ]).returning();
      const [tmallOld, tmall, pdd, vip] = jobs;
      const finishedAt = new Date("2026-08-11T03:00:00.000Z");
      await db.insert(schema.integrationRuns).values([
        { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "tmall-old", status: "succeeded", importJobId: tmallOld.id, finishedAt },
        { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "tmall", status: "succeeded", importJobId: tmall.id, finishedAt },
        { connector: "jdy", stream: "pdd-sku-crosswalk-observation", idempotencyKey: "pdd", status: "succeeded", importJobId: pdd.id, finishedAt },
        { connector: "jdy", stream: "vip-product-crosswalk-observation", idempotencyKey: "vip", status: "succeeded", importJobId: vip.id, finishedAt },
      ]);
      await db.insert(schema.stagingRows).values([
        {
          importJobId: tmallOld.id, rowNo: 1, status: "pending",
          targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: "旧店", platformSkuId: "OLD" }, _identity: { skuId: 999 } },
        },
        {
          importJobId: tmall.id, rowNo: 1, status: "pending",
          targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: "旗舰店", platformSkuId: "T1", barcode: "6901" }, _identity: { skuId: 101 } },
        },
        {
          importJobId: tmall.id, rowNo: 2, status: "pending",
          targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: "旗舰店", platformSkuId: "T1", barcode: "6901" }, _identity: { skuId: 101 } },
        },
        {
          importJobId: tmall.id, rowNo: 3, status: "pending",
          targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: "旗舰店", platformSkuId: "T2", barcode: "6902" }, _identity: {} },
        },
        {
          importJobId: tmall.id, rowNo: 4, status: "pending",
          targetTable: "jdy_tmall_sku_crosswalk_observation",
          payload: { data: { shopName: "旗舰店", platformSkuId: "" }, _identity: {} },
        },
        {
          importJobId: pdd.id, rowNo: 1, status: "pending",
          targetTable: "jdy_pdd_sku_crosswalk_observation",
          payload: { data: { shopName: "拼多多店", platformSkuId: "P1", merchantSkuCode: "SW1" }, _identity: {} },
        },
        {
          importJobId: pdd.id, rowNo: 2, status: "pending",
          targetTable: "jdy_pdd_sku_crosswalk_observation",
          payload: { data: { shopName: "拼多多店", platformSkuId: "P1", merchantSkuCode: "SW1" }, _identity: {} },
        },
        {
          importJobId: pdd.id, rowNo: 3, status: "pending",
          targetTable: "jdy_pdd_sku_crosswalk_observation",
          payload: { data: { shopName: "拼多多店", platformSkuId: "P2" }, _identity: {} },
        },
        {
          importJobId: vip.id, rowNo: 1, status: "pending",
          targetTable: "jdy_vip_product_crosswalk_observation",
          payload: { data: { platformProductId: "V1", barcode: "6911" }, _identity: { skuId: 201 } },
        },
        {
          importJobId: vip.id, rowNo: 2, status: "pending",
          targetTable: "jdy_vip_product_crosswalk_observation",
          payload: { data: { platformProductId: "V2", barcode: "6912" }, _identity: { skuId: 202 } },
        },
        {
          importJobId: vip.id, rowNo: 3, status: "pending",
          targetTable: "jdy_vip_product_crosswalk_observation",
          payload: { data: { platformProductId: "V2", barcode: "6912" }, _identity: { skuId: 203 } },
        },
      ]);
      await db.insert(schema.aliasExceptions).values({
        aliasType: "sku_barcode",
        scope: "JIANDAOYUN",
        rawValue: "6902",
        status: "open",
      });

      const result = await loadCommerceIdentityCoverage(db, {
        now: new Date("2026-08-12T04:00:00.000Z"),
      });

      expect(result.state).toBe("ready");
      expect(result.authority).toBe("observation_only");
      expect(result.summary).toEqual({
        availablePlatforms: 3,
        totalPlatforms: 3,
        sourceRows: 10,
        uniqueIdentities: 6,
        mappedIdentities: 2,
        identityPct: 33.3,
        qualityIssues: 5,
        repairBacklog: 5,
      });
      const tmallRow = result.platforms.find((item) => item.key === "tmall");
      expect(tmallRow).toMatchObject({
        sourceRows: 4,
        invalidIdentityRows: 1,
        uniqueIdentities: 2,
        mappedIdentities: 1,
        identityPct: 50,
        bridgeIdentities: 2,
        bridgePct: 100,
        duplicateGroups: 1,
        duplicateRows: 1,
        conflictingMappings: 0,
        repairBacklog: 2,
        ageDays: 1,
        fresh: true,
      });
      expect(tmallRow?.gate).toContain("重复组");
      expect(result.platforms.find((item) => item.key === "pdd")).toMatchObject({
        uniqueIdentities: 2,
        mappedIdentities: 0,
        identityPct: 0,
        bridgeIdentities: 1,
        duplicateGroups: 1,
        repairBacklog: 2,
      });
      expect(result.platforms.find((item) => item.key === "vip")).toMatchObject({
        uniqueIdentities: 2,
        mappedIdentities: 1,
        conflictingMappings: 1,
        repairBacklog: 1,
      });
      expect(result.repairQueue).toHaveLength(5);
      expect(result.repairQueue[0]).toMatchObject({
        platformKey: "vip",
        externalId: "V2",
        issue: "conflicting_mapping",
        priority: 1,
        claimable: false,
      });
      expect(result.repairQueue.find((item) => item.platformKey === "tmall" && item.externalId === "T2"))
        .toMatchObject({
          bridgeValue: "6902",
          issue: "unmapped_with_bridge",
          priority: 2,
          claimable: true,
          exceptionStatus: "open",
        });
      expect(result.repairQueue.find((item) => item.platformKey === "pdd" && item.externalId === "P1"))
        .toMatchObject({
          issue: "unmapped_with_bridge",
          priority: 2,
          claimable: false,
        });
    } finally {
      await client.close();
    }
  });

  it("仅开放异常可直接认领；已解决、已忽略和缺异常保留各自下一步", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "身份裁决人" }).returning();
      const [job] = await db.insert(schema.importJobs).values({
        template: "jdy_tmall_sku_crosswalk_observation",
        filename: "tmall-exception-states",
        sourceAsOf: "2026-08-11",
        createdBy: actor.id,
        status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values({
        connector: "jdy",
        stream: "tmall-sku-crosswalk-observation",
        idempotencyKey: "tmall-exception-states",
        status: "succeeded",
        importJobId: job.id,
        finishedAt: new Date("2026-08-11T03:00:00.000Z"),
      });
      await db.insert(schema.stagingRows).values([
        { importJobId: job.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation", payload: { data: { shopName: "旗舰店", platformSkuId: "OPEN", barcode: "6901" }, _identity: {} } },
        { importJobId: job.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation", payload: { data: { shopName: "旗舰店", platformSkuId: "RESOLVED", barcode: "6902" }, _identity: {} } },
        { importJobId: job.id, rowNo: 3, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation", payload: { data: { shopName: "旗舰店", platformSkuId: "IGNORED", barcode: "6903" }, _identity: {} } },
        { importJobId: job.id, rowNo: 4, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation", payload: { data: { shopName: "旗舰店", platformSkuId: "MISSING", barcode: "6904" }, _identity: {} } },
      ]);
      await db.insert(schema.aliasExceptions).values([
        { aliasType: "sku_barcode", scope: "JIANDAOYUN", rawValue: "6901", status: "open" },
        { aliasType: "sku_barcode", scope: "JIANDAOYUN", rawValue: "6902", status: "resolved", resolvedTargetId: 101, resolvedBy: actor.id, resolvedAt: new Date("2026-08-11T04:00:00.000Z") },
        { aliasType: "sku_barcode", scope: "JIANDAOYUN", rawValue: "6903", status: "ignored" },
      ]);

      const result = await loadCommerceIdentityCoverage(db);
      const rows = new Map(result.repairQueue.map((row) => [row.externalId, row]));
      expect(rows.get("OPEN")).toMatchObject({ claimable: true, exceptionStatus: "open" });
      expect(rows.get("RESOLVED")).toMatchObject({ claimable: false, exceptionStatus: "resolved" });
      expect(rows.get("RESOLVED")?.action).toContain("重新同步");
      expect(rows.get("IGNORED")).toMatchObject({ claimable: false, exceptionStatus: "ignored" });
      expect(rows.get("MISSING")).toMatchObject({ claimable: false, exceptionStatus: null });
    } finally {
      await client.close();
    }
  });

  it("没有成功批次时保持数据不足，不伪造零覆盖", async () => {
    const { db, client } = await createTestDb();
    try {
      const result = await loadCommerceIdentityCoverage(db);
      expect(result.state).toBe("insufficient");
      expect(result.summary.identityPct).toBeNull();
      expect(result.platforms).toHaveLength(3);
      expect(result.platforms.every((item) => item.state === "insufficient")).toBe(true);
      expect(result.repairQueue).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
