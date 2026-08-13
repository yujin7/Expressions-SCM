import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  connectorErrorSummary,
  getOpsHealth,
  listErrorLogs,
  operationalErrorSummary,
} from "@/server/modules/admin/health";
import { createTestDb } from "../helpers/db";

describe("admin connector run health", () => {
  it("returns only the latest run per stream with checkpoint and scoped alias controls", async () => {
    const { db } = await createTestDb();
    const oldSuccessAt = new Date(Date.now() - 6 * 3_600_000);
    const failedAt = new Date(Date.now() - 90 * 60_000);
    const jstSuccessAt = new Date(Date.now() - 30 * 60_000);

    const [priorJdy] = await db.insert(schema.integrationRuns).values({
      connector: "jdy",
      stream: "product-master-observation",
      idempotencyKey: "health:jdy:prior",
      status: "succeeded",
      requestScope: {
        sourceAsOf: "2026-07-20",
        schemaHash: "a".repeat(64),
        unresolvedAliases: 1,
      },
      sourceRows: 5,
      stagedRows: 5,
      rejectedRows: 0,
      startedAt: new Date(oldSuccessAt.getTime() - 60_000),
      finishedAt: oldSuccessAt,
    }).returning();
    await db.insert(schema.integrationRuns).values({
      connector: "jdy",
      stream: "product-master-observation",
      idempotencyKey: "health:jdy:latest",
      status: "failed",
      requestScope: {
        sourceAsOf: "2026-07-21",
        schemaHash: "B".repeat(64),
        unresolvedAliases: "2",
        releaseBlocked: true,
        schemaDrift: true,
        fieldProfile: {
          version: "yonyou-field-profile/v1",
          sampledRecords: 12,
          fieldCount: 8,
          sensitiveFieldCount: 2,
          sensitiveCategories: ["financial", "contact", "untrusted-category"],
          truncated: true,
          fields: [{ path: "bankAccount", leakedValue: "NEVER_RETURN_VALUE" }],
        },
      },
      evidencePath: "/protected/evidence/never-return.json",
      evidenceHash: "f".repeat(64),
      sourceRows: 8,
      stagedRows: 3,
      rejectedRows: 2,
      error: "401 token=raw-secret at https://example.invalid/api?api_key=raw-secret",
      startedAt: new Date(failedAt.getTime() - 60_000),
      finishedAt: failedAt,
    });
    const [jstRun] = await db.insert(schema.integrationRuns).values({
      connector: "jst",
      stream: "outbound-sales-daily",
      idempotencyKey: "health:jst:latest",
      status: "succeeded",
      requestScope: {
        sourceAsOf: "not-a-date",
        schemaHash: "not-a-hash",
        unresolvedAliases: 0,
        emptySource: true,
      },
      sourceRows: 12,
      stagedRows: 12,
      rejectedRows: 0,
      startedAt: new Date(jstSuccessAt.getTime() - 60_000),
      finishedAt: jstSuccessAt,
    }).returning();

    await db.insert(schema.integrationCheckpoints).values([
      {
        connector: "jdy",
        stream: "product-master-observation",
        cursor: "protected-cursor",
        version: 3,
        lastRunId: priorJdy.id,
        lastSuccessAt: oldSuccessAt,
        updatedAt: oldSuccessAt,
      },
      {
        connector: "jst",
        stream: "outbound-sales-daily",
        cursor: "protected-cursor-2",
        version: 2,
        lastRunId: jstRun.id,
        lastSuccessAt: jstSuccessAt,
        updatedAt: jstSuccessAt,
      },
    ]);
    await db.insert(schema.aliasExceptions).values([
      { aliasType: "sku_code", scope: "JIANDAOYUN", rawValue: "J1", status: "open" },
      { aliasType: "warehouse", scope: "JIANDAOYUN", rawValue: "J2", status: "open" },
      { aliasType: "sku_code", scope: "JIANDAOYUN", rawValue: "J3", status: "resolved" },
      { aliasType: "sku_code", scope: "JST", rawValue: "S1", status: "open" },
      { aliasType: "sku_code", scope: "GLOBAL", rawValue: "G1", status: "open" },
    ]);
    await db.insert(schema.errorLogs).values({
      errorId: "deadbeef",
      path: "/api/integrations/run",
      method: "POST",
      message: "upstream 401 token=DEMO_SECRET_VALUE https://example.invalid?key=secret",
      stack: "Error: DEMO_SECRET_VALUE",
    });
    await db.insert(schema.jobRuns).values({
      job: "connector-probe",
      ok: false,
      message: "forbidden access_token=DEMO_JOB_SECRET",
      startedAt: failedAt,
      finishedAt: failedAt,
    });

    const result = await getOpsHealth(db);
    expect(result.connectorRuns).toHaveLength(2);

    const jdy = result.connectorRuns.find((row) => row.connector === "jdy");
    expect(jdy).toMatchObject({
      stream: "product-master-observation",
      status: "failed",
      sourceRows: 8,
      stagedRows: 3,
      rejectedRows: 2,
      sourceAsOf: "2026-07-21",
      schemaHashPrefix: "bbbbbbbbbbbb",
      unresolvedAliases: 2,
      openScopedAliasExceptions: 2,
      checkpointVersion: 3,
      checkpointOnLatestRun: false,
      emptySource: false,
      releaseBlocked: true,
      schemaDrift: true,
      fieldProfile: {
        version: "yonyou-field-profile/v1",
        sampledRecords: 12,
        fieldCount: 8,
        sensitiveFieldCount: 2,
        sensitiveCategories: ["contact", "financial"],
        truncated: true,
      },
      errorSummary: "外部系统认证或授权失败",
    });
    expect(jdy?.checkpointAgeHours).toBeGreaterThanOrEqual(5.9);
    expect(jdy?.checkpointAgeHours).toBeLessThanOrEqual(6.1);

    const jst = result.connectorRuns.find((row) => row.connector === "jst");
    expect(jst).toMatchObject({
      status: "succeeded",
      sourceAsOf: null,
      schemaHashPrefix: null,
      unresolvedAliases: 0,
      openScopedAliasExceptions: 1,
      checkpointVersion: 2,
      checkpointOnLatestRun: true,
      emptySource: true,
      releaseBlocked: false,
      schemaDrift: false,
      fieldProfile: null,
      errorSummary: null,
    });

    expect(result.connectors.find((row) => row.key === "jdy")).toMatchObject({
      identityScope: "JIANDAOYUN",
      identityClearanceState: "blocked",
      openScopedAliasExceptions: 2,
      observedScopedIdentities: 2,
      operational: false,
    });
    expect(result.connectors.find((row) => row.key === "jst")).toMatchObject({
      identityScope: "JST",
      identityClearanceState: "blocked",
      openScopedAliasExceptions: 1,
      observedScopedIdentities: 1,
      operational: false,
    });
    expect(result.connectors.find((row) => row.key === "yy")).toMatchObject({
      identityScope: "YONYOU",
      identityClearanceState: "unknown",
      openScopedAliasExceptions: null,
      observedScopedIdentities: null,
      operational: false,
    });

    const serialized = JSON.stringify(result.connectorRuns);
    expect(serialized).not.toContain("raw-secret");
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("protected/evidence");
    expect(serialized).not.toContain("protected-cursor");
    expect(serialized).not.toContain("bankAccount");
    expect(serialized).not.toContain("NEVER_RETURN_VALUE");
    expect(serialized).not.toContain("untrusted-category");
    expect(jdy).not.toHaveProperty("evidencePath");
    expect(jdy).not.toHaveProperty("evidenceHash");
    expect(jdy).not.toHaveProperty("error");
    expect(jdy).not.toHaveProperty("requestScope");

    expect(result.recentErrors).toMatchObject([{
      errorId: "deadbeef",
      message: "认证或授权异常（详情仅限受控日志）",
    }]);
    expect(result.lastJobRuns).toMatchObject([{
      job: "connector-probe",
      ok: false,
      message: "认证或授权异常（详情仅限受控日志）",
    }]);
    const healthPayload = JSON.stringify(result);
    expect(healthPayload).not.toContain("DEMO_SECRET_VALUE");
    expect(healthPayload).not.toContain("DEMO_JOB_SECRET");
    expect(healthPayload).not.toContain("example.invalid");

    const errorListPayload = JSON.stringify(await listErrorLogs(50, db));
    expect(errorListPayload).not.toContain("DEMO_SECRET_VALUE");
    expect(errorListPayload).not.toContain("example.invalid");
  });

  it("reduces arbitrary stored errors to bounded safe categories", () => {
    const source = `supplier raw value ${"sensitive".repeat(30)}`;
    const summary = connectorErrorSummary(source);
    expect(summary).toBe("连接器运行失败（详情仅限受控日志）");
    expect(summary?.length).toBeLessThanOrEqual(80);
    expect(summary).not.toContain("sensitive");
    expect(connectorErrorSummary(null)).toBeNull();
    expect(operationalErrorSummary("database constraint value=SECRET"))
      .toBe("数据库或事务异常（详情仅限受控日志）");
    expect(operationalErrorSummary("arbitrary SECRET content"))
      .toBe("未预期系统异常（详情仅限受控日志）");
  });
});
