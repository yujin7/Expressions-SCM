import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { loadDataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { createTestDb } from "../helpers/db";

describe("三方数据来源证据矩阵", () => {
  it("区分内部事实、成功观察、最新失败和仅有契约", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "数据责任人" }).returning();
      const [job] = await db.insert(schema.importJobs).values({
        template: "jdy_observation",
        filename: "jdy-observation",
        sourceAsOf: "2026-08-11",
        createdBy: actor.id,
        status: "done",
      }).returning();
      await db.insert(schema.integrationRuns).values([
        {
          connector: "jdy",
          stream: "tmall-sku-sales-observation",
          idempotencyKey: "jdy-latest-failed",
          status: "failed",
          error: "schema drift",
          startedAt: new Date("2026-08-12T02:00:00.000Z"),
          finishedAt: new Date("2026-08-12T02:01:00.000Z"),
        },
        {
          connector: "jdy",
          stream: "tmall-sku-sales-observation",
          idempotencyKey: "jdy-success",
          status: "succeeded",
          sourceRows: 10,
          stagedRows: 9,
          rejectedRows: 1,
          requestScope: {
            releaseBlocked: true,
            schemaDrift: false,
            sourceAsOf: "2026-08-11",
            controlSummary: {
              version: "jdy-control-v1",
              status: "review",
              activeRows: 10,
              deletedRows: 0,
              missingFieldValues: 4,
              missingBusinessKeyRows: 1,
              duplicateKeyGroups: 2,
              duplicateRows: 5,
              invalidNumericValues: 1,
              reconciliationMismatchedRows: 3,
              reconciliationInsufficientRows: 2,
            },
          },
          importJobId: job.id,
          startedAt: new Date("2026-08-12T01:00:00.000Z"),
          finishedAt: new Date("2026-08-12T01:01:00.000Z"),
        },
        {
          connector: "yy",
          stream: "yonbip-digitalmodel-vendor-list",
          idempotencyKey: "yy-success",
          status: "succeeded",
          sourceRows: 3,
          stagedRows: 3,
          requestScope: { releaseBlocked: true, schemaDrift: true, sourceAsOf: "2026-08-11" },
          importJobId: job.id,
          startedAt: new Date("2026-08-12T01:30:00.000Z"),
          finishedAt: new Date("2026-08-12T01:31:00.000Z"),
        },
        {
          connector: "yy",
          stream: "yonbip-scm-purchaseorder-list",
          idempotencyKey: "yy-console-grant-blocked",
          status: "succeeded",
          sourceRows: 0,
          stagedRows: 0,
          error: "待控制台授权：310037",
          startedAt: new Date("2026-08-12T02:30:00.000Z"),
          finishedAt: new Date("2026-08-12T02:31:00.000Z"),
        },
        {
          connector: "jst",
          stream: "outbound-sales-daily",
          idempotencyKey: "jst-future-source-date",
          status: "succeeded",
          sourceRows: 1,
          stagedRows: 1,
          requestScope: { sourceAsOf: "2026-08-14" },
          startedAt: new Date("2026-08-12T16:00:00.000Z"),
          finishedAt: new Date("2026-08-12T16:01:00.000Z"),
        },
        {
          connector: "jst",
          stream: "inventory-total-delta",
          idempotencyKey: "jst-invalid-calendar-date",
          status: "succeeded",
          sourceRows: 1,
          stagedRows: 1,
          requestScope: { sourceAsOf: "2026-02-30" },
          startedAt: new Date("2026-08-12T16:05:00.000Z"),
          finishedAt: new Date("2026-08-12T16:06:00.000Z"),
        },
      ]);
      await db.insert(schema.aliasExceptions).values({
        aliasType: "sku_barcode",
        scope: "JIANDAOYUN",
        rawValue: "6901",
        status: "open",
      });

      const result = await loadDataSourceReadiness(db, {
        env: {} as NodeJS.ProcessEnv,
        now: new Date("2026-08-12T16:30:00.000Z"),
      });

      expect(result.map((row) => row.key)).toEqual(["SCM", "JIANDAOYUN", "JST", "YONYOU"]);
      expect(result[0]).toMatchObject({
        state: "operational",
        configured: true,
        configurationReady: true,
        scmEvidence: expect.objectContaining({
          "sku-master": expect.objectContaining({ rows: 0, freshness: "unknown" }),
          "quality-inspections": expect.objectContaining({ rows: 0, freshness: "unknown" }),
          "planning-lines": expect.objectContaining({ rows: 0, freshness: "unknown" }),
        }),
      });
      expect(result.find((row) => row.key === "JIANDAOYUN")).toMatchObject({
        state: "observation",
        configurationReady: false,
        successfulStreams: 1,
        successfulStreamKeys: ["tmall-sku-sales-observation"],
        latestFailedStreams: 1,
        sourceRows: 10,
        stagedRows: 9,
        rejectedRows: 1,
        sourceAsOfStart: "2026-08-11",
        sourceAsOfEnd: "2026-08-11",
        openIdentityExceptions: 1,
        observedIdentities: 1,
      });
      expect(result.find((row) => row.key === "JIANDAOYUN")?.streams).toEqual([
        expect.objectContaining({
          stream: "tmall-sku-sales-observation",
          latestStatus: "failed",
          sourceAsOf: "2026-08-11",
          sourceRows: 10,
          rejectedRows: 1,
          releaseBlocked: true,
          freshness: "current",
          freshnessMaxAgeDays: 45,
          businessAgeDays: 2,
          quality: {
            status: "review",
            activeRows: 10,
            deletedRows: 0,
            missingFieldValues: 4,
            missingBusinessKeyRows: 1,
            duplicateKeyGroups: 2,
            duplicateRows: 5,
            invalidNumericValues: 1,
            reconciliationMismatchedRows: 3,
            reconciliationInsufficientRows: 2,
          },
        }),
      ]);
      expect(result.find((row) => row.key === "JST")).toMatchObject({
        state: "observation",
        configurationReady: false,
        contractSelectionState: "not_required",
        selectedContractCount: 0,
        successfulStreams: 2,
      });
      expect(result.find((row) => row.key === "JST")?.streams).toEqual([
        expect.objectContaining({
          stream: "inventory-total-delta",
          sourceAsOf: null,
          sourceTimeInvalid: true,
          freshness: "unknown",
        }),
        expect.objectContaining({
          stream: "outbound-sales-daily",
          sourceAsOf: "2026-08-14",
          sourceTimeInvalid: true,
          pipelineAgeHours: 0.5,
          freshness: "unknown",
        }),
      ]);
      expect(result.find((row) => row.key === "YONYOU")).toMatchObject({
        state: "observation",
        configurationReady: false,
        successfulStreams: 1,
        successfulStreamKeys: ["yonbip-digitalmodel-vendor-list"],
      });
      expect(result.find((row) => row.key === "YONYOU")?.streams).toEqual([
        expect.objectContaining({
          stream: "yonbip-digitalmodel-vendor-list",
          authorizationBlocked: false,
          schemaDrift: true,
          releaseBlocked: true,
          lastSuccessAt: "2026-08-12T01:31:00.000Z",
        }),
        expect.objectContaining({
          stream: "yonbip-scm-purchaseorder-list",
          authorizationBlocked: true,
          lastSuccessAt: null,
          freshness: "unknown",
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("拒绝带尾随垃圾的截止日并保留完整 RFC3339 时间戳", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(schema.integrationRuns).values([
        {
          connector: "jst",
          stream: "outbound-sales-daily",
          idempotencyKey: "jst-malformed-source-date",
          status: "succeeded",
          sourceRows: 1,
          stagedRows: 1,
          requestScope: { sourceAsOf: "2026-08-11garbage" },
          startedAt: new Date("2026-08-12T00:00:00.000Z"),
          finishedAt: new Date("2026-08-12T00:01:00.000Z"),
        },
        {
          connector: "jst",
          stream: "inventory-total-delta",
          idempotencyKey: "jst-valid-rfc3339-source-time",
          status: "succeeded",
          sourceRows: 1,
          stagedRows: 1,
          requestScope: { observedAt: "2026-08-11T23:59:00+08:00" },
          startedAt: new Date("2026-08-12T00:05:00.000Z"),
          finishedAt: new Date("2026-08-12T00:06:00.000Z"),
        },
      ]);

      const result = await loadDataSourceReadiness(db, {
        env: {} as NodeJS.ProcessEnv,
        now: new Date("2026-08-12T00:30:00.000Z"),
      });
      const streams = result.find((row) => row.key === "JST")?.streams;

      expect(streams).toEqual([
        expect.objectContaining({
          stream: "inventory-total-delta",
          sourceAsOf: "2026-08-11",
          sourceTimeInvalid: false,
          freshness: "current",
        }),
        expect.objectContaining({
          stream: "outbound-sales-daily",
          sourceAsOf: null,
          sourceTimeInvalid: true,
          freshness: "unknown",
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("拒绝会被运行时归一化的越界 RFC3339 时间", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(schema.integrationRuns).values({
        connector: "jst",
        stream: "outbound-sales-daily",
        idempotencyKey: "jst-out-of-range-rfc3339-time",
        status: "succeeded",
        sourceRows: 1,
        stagedRows: 1,
        requestScope: { sourceAsOf: "2026-08-11T24:00:00Z" },
        startedAt: new Date("2026-08-11T14:00:00.000Z"),
        finishedAt: new Date("2026-08-11T14:01:00.000Z"),
      });

      const result = await loadDataSourceReadiness(db, {
        env: {} as NodeJS.ProcessEnv,
        now: new Date("2026-08-11T14:30:00.000Z"),
      });
      expect(result.find((row) => row.key === "JST")?.streams).toEqual([
        expect.objectContaining({
          sourceAsOf: null,
          sourceTimeInvalid: true,
          freshness: "unknown",
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("按上海业务日解释跨时区时间戳并阻断未来证据", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(schema.integrationRuns).values({
        connector: "jst",
        stream: "outbound-sales-daily",
        idempotencyKey: "jst-cross-zone-future-cutoff",
        status: "succeeded",
        sourceRows: 1,
        stagedRows: 1,
        requestScope: { sourceAsOf: "2026-08-11T23:00:00-12:00" },
        startedAt: new Date("2026-08-11T14:00:00.000Z"),
        finishedAt: new Date("2026-08-11T14:01:00.000Z"),
      });

      const result = await loadDataSourceReadiness(db, {
        env: {} as NodeJS.ProcessEnv,
        now: new Date("2026-08-11T14:30:00.000Z"),
      });
      expect(result.find((row) => row.key === "JST")?.streams).toEqual([
        expect.objectContaining({
          sourceAsOf: "2026-08-12",
          sourceTimeInvalid: true,
          freshness: "unknown",
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("没有显式 emptySource 标志时仍从零源行推导空源", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(schema.integrationRuns).values({
        connector: "jst",
        stream: "outbound-sales-daily",
        idempotencyKey: "jst-zero-source-rows",
        status: "succeeded",
        sourceRows: 0,
        stagedRows: 0,
        requestScope: { sourceAsOf: "2026-08-11" },
        startedAt: new Date("2026-08-12T00:00:00.000Z"),
        finishedAt: new Date("2026-08-12T00:01:00.000Z"),
      });

      const result = await loadDataSourceReadiness(db, {
        env: {} as NodeJS.ProcessEnv,
        now: new Date("2026-08-12T00:30:00.000Z"),
      });
      expect(result.find((row) => row.key === "JST")?.streams).toEqual([
        expect.objectContaining({
          sourceRows: 0,
          stagedRows: 0,
          emptySource: true,
          freshness: "current",
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("把旧计划判为过期并排除已关闭 S&OP 周期", async () => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "计划责任人" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "P-STALE", nameCn: "旧计划产品" }).returning();
      const [sku] = await db.insert(schema.skus).values({
        code: "SKU-STALE",
        name: "旧计划 SKU",
        spuId: spu.id,
        baseUom: "pcs",
        skuType: "finished",
      }).returning();
      const [version] = await db.insert(schema.planningVersions).values({
        name: "旧周计划",
        weekStart: "2026-06-01",
        engineVersion: "test",
        parameters: {},
        sourceMeta: {},
        lineCount: 1,
        suggestedCount: 1,
        suppressedCount: 0,
        digest: "stale-plan",
        idempotencyKey: "stale-plan",
        createdBy: actor.id,
      }).returning();
      await db.insert(schema.planningVersionLines).values({
        versionId: version.id,
        skuId: sku.id,
        skuCode: sku.code,
        skuName: sku.name,
        baseUom: sku.baseUom,
        suggestedQty: "10",
        onHand: "0",
        inTransit: "0",
        daily: "1",
        safetyQty: "5",
        explanation: {},
      });
      await db.insert(schema.sopCycles).values({
        month: "2026-06",
        name: "已关闭旧周期",
        status: "closed",
        planningVersionId: version.id,
        planDigest: version.digest,
        idempotencyKey: "closed-old-cycle",
        createdBy: actor.id,
        frozenBy: actor.id,
        frozenAt: new Date("2026-06-02T00:00:00.000Z"),
        executingBy: actor.id,
        executingAt: new Date("2026-06-03T00:00:00.000Z"),
        closedBy: actor.id,
        closedAt: new Date("2026-06-30T00:00:00.000Z"),
      });

      const result = await loadDataSourceReadiness(db, {
        env: {} as NodeJS.ProcessEnv,
        now: new Date("2026-08-12T00:30:00.000Z"),
      });
      const scm = result.find((row) => row.key === "SCM");
      expect(scm?.scmEvidence["planning-lines"]).toMatchObject({
        rows: 1,
        asOf: "2026-06-01",
        freshnessMaxAgeDays: 8,
        freshness: "stale",
      });
      expect(scm?.scmEvidence["sop-cycles"]).toMatchObject({
        rows: 0,
        freshness: "unknown",
      });
    } finally {
      await client.close();
    }
  });
});
