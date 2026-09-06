import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  connectorErrorSummary,
  getOpsHealth,
  listErrorLogs,
  operationalErrorSummary,
} from "@/server/modules/admin/health";
import { createTestDb } from "../helpers/db";
import { connectorProbeEvidence } from "@/server/integrations/connector-probe-evidence";
import { yonyouJobSummary } from "@/lib/yonyou-job-summary";

const observation = (blocked: boolean, id = 1) => ({
  runId: id, importJobId: blocked ? null : id, sourceRows: blocked ? 0 : 1250,
  stagedRows: blocked ? 0 : 1250, replayed: false, blockedByConsoleGrant: blocked,
});
const RAW_ERROR_SENTINEL = "YY_RAW_ERROR_SENTINEL_20260906";

describe("admin connector run health", () => {
  it("用友历史成功中的授权等待独立显示，保留既有检查点；真实零行成功不误判", async () => {
    const { db, client } = await createTestDb();
    try {
      const [user] = await db.insert(schema.users).values({ name: "合成运维" }).returning();
      const [job] = await db.insert(schema.importJobs).values({ template: "yonyou-observation", filename: "synthetic.json", createdBy: user.id }).returning();
      const priorAt = new Date(Date.now() - 120_000);
      const latestAt = new Date(Date.now() - 30_000);
      const [prior] = await db.insert(schema.integrationRuns).values({
        connector: "yy", stream: "cost", idempotencyKey: "health:yy:prior", status: "succeeded",
        importJobId: job.id, startedAt: priorAt, finishedAt: priorAt,
      }).returning();
      await db.insert(schema.integrationCheckpoints).values({
        connector: "yy", stream: "cost", cursor: "synthetic-prior", version: 1, lastRunId: prior.id, lastSuccessAt: priorAt,
      });
      await db.insert(schema.integrationRuns).values([
        { connector: "yy", stream: "cost", idempotencyKey: "health:yy:waiting", status: "succeeded", error: "待控制台授权：310037", startedAt: latestAt, finishedAt: latestAt },
        { connector: "yonyou", stream: "legacy", idempotencyKey: "health:yonyou:waiting", status: "succeeded", error: "待控制台授权：310005", startedAt: latestAt, finishedAt: latestAt },
        { connector: "yy", stream: "empty", idempotencyKey: "health:yy:empty", status: "succeeded", importJobId: job.id, sourceRows: 0, stagedRows: 0, startedAt: latestAt, finishedAt: latestAt },
        { connector: "jst", stream: "not-yy", idempotencyKey: "health:jst:not-yy", status: "succeeded", error: `待控制台授权：310037 ${RAW_ERROR_SENTINEL}`, startedAt: latestAt, finishedAt: latestAt },
        { connector: "yy", stream: "missing-job", idempotencyKey: "health:yy:missing-job", status: "succeeded", startedAt: latestAt, finishedAt: latestAt },
        { connector: "yy", stream: "mixed", idempotencyKey: "health:yy:mixed", status: "succeeded", importJobId: job.id, error: `待控制台授权：310037 ${RAW_ERROR_SENTINEL}`, startedAt: latestAt, finishedAt: latestAt },
        { connector: "yonyou", stream: "other-error", idempotencyKey: "health:yy:error", status: "succeeded", importJobId: job.id, error: RAW_ERROR_SENTINEL, startedAt: latestAt, finishedAt: latestAt },
        { connector: "yy", stream: "tail-error", idempotencyKey: "health:yy:tail-error", status: "succeeded", error: `待控制台授权：310037 ${RAW_ERROR_SENTINEL}`, startedAt: latestAt, finishedAt: latestAt },
        { connector: "yy", stream: "nonzero-wait", idempotencyKey: "health:yy:nonzero-wait", status: "succeeded", error: "待控制台授权：310037", sourceRows: 1, startedAt: latestAt, finishedAt: latestAt },
        { connector: "yy", stream: "rejected-wait", idempotencyKey: "health:yy:rejected-wait", status: "succeeded", error: "待控制台授权：310037", rejectedRows: 1, startedAt: latestAt, finishedAt: latestAt },
        { connector: "yy", stream: "evidence-wait", idempotencyKey: "health:yy:evidence-wait", status: "succeeded", error: "待控制台授权：310037", evidenceHash: "f".repeat(64), evidencePath: RAW_ERROR_SENTINEL, startedAt: latestAt, finishedAt: latestAt },
      ]);
      const result = await getOpsHealth(db);
      expect(result.connectorRuns.find((row) => row.connector === "yy" && row.stream === "cost")).toMatchObject({
        status: "succeeded", authorizationBlocked: true, checkpointVersion: 1, checkpointOnLatestRun: false,
        checkpointLastSuccessAt: priorAt.toISOString(), errorSummary: expect.stringContaining("等待用友控制台授权"),
      });
      expect(result.connectorRuns.find((row) => row.stream === "legacy")).toMatchObject({ authorizationBlocked: true, resultInconsistent: false });
      expect(result.connectorRuns.find((row) => row.stream === "empty")).toMatchObject({
        status: "succeeded", sourceRows: 0, authorizationBlocked: false, resultInconsistent: false, errorSummary: null,
      });
      expect(result.connectorRuns.find((row) => row.connector === "jst")).toMatchObject({ authorizationBlocked: false });
      for (const stream of ["missing-job", "mixed", "other-error", "tail-error", "nonzero-wait", "rejected-wait", "evidence-wait"]) {
        expect(result.connectorRuns.find((row) => row.stream === stream)).toMatchObject({
          status: "succeeded", authorizationBlocked: false, resultInconsistent: true, checkpointOnLatestRun: false,
          errorSummary: expect.stringContaining("结果待核对"),
        });
      }
      expect(JSON.stringify(result)).not.toContain(RAW_ERROR_SENTINEL);
    } finally { await client.close(); }
  });

  it.each([
    { summary: { status: "succeeded", results: [observation(true)], awaitingConsoleGrant: ["成本"] }, expected: "awaiting_authorization", label: "等待授权" },
    { summary: { status: "partial", results: [observation(true), observation(false, 2)], awaitingConsoleGrant: ["成本"] }, expected: "partial", label: "部分完成" },
    { summary: { status: "succeeded", results: [observation(false)], awaitingConsoleGrant: [] }, expected: "succeeded", label: "已读取" },
  ])("用友 job 健康读模型展示 $expected 而非统一任务成功", async ({ summary, expected, label }) => {
    const { db, client } = await createTestDb();
    try {
      const at = new Date();
      await db.insert(schema.jobRuns).values({ job: "sync-yonyou", ok: true, message: JSON.stringify(yonyouJobSummary(summary)), startedAt: at, finishedAt: at });
      const result = await getOpsHealth(db);
      expect(result.lastJobRuns.find((row) => row.job === "sync-yonyou")).toMatchObject({
        ok: true, outcome: { status: expected }, message: expect.stringContaining(label),
      });
    } finally { await client.close(); }
  });

  it.each([
    '{"status":"succeeded","results":[',
    JSON.stringify({ status: "succeeded", awaitingConsoleGrant: [], results: [{ ...observation(false), importJobId: null, sourceRows: 0, stagedRows: 0, replayed: true }] }),
  ])("截断历史或无导入任务的旧假重放摘要不显示绿色成功", async (message) => {
    const { db, client } = await createTestDb();
    try {
      const at = new Date();
      await db.insert(schema.jobRuns).values({ job: "sync-yonyou", ok: true, message, startedAt: at, finishedAt: at });
      const result = await getOpsHealth(db);
      expect(result.lastJobRuns.find((row) => row.job === "sync-yonyou")).toMatchObject({ ok: true, outcome: { status: "unknown" }, message: expect.stringContaining("取数结果未确认") });
    } finally { await client.close(); }
  });

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
    await db.insert(schema.jobRuns).values({
      job: "probe-jst-permissions",
      ok: true,
      message: JSON.stringify(connectorProbeEvidence({
        c: "jst",
        s: "partial",
        a: "validated",
        p: 1,
        t: 6,
        r: ["ok", "api_code_190", "api_code_110", "api_code_190", "api_code_190", "api_code_190"],
        b: null,
      })),
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
    expect(result.connectorProbes).toHaveLength(1);
    expect(result.connectorProbes[0]).toMatchObject({
      connector: "jst",
      status: "partial",
      authentication: "validated",
      passed: 1,
      total: 6,
      bindingMatches: false,
      writesPerformed: false,
    });
    expect(result.connectorProbes[0]?.checks.slice(0, 2)).toEqual([
      { key: "shops", label: "店铺", result: "ok", passed: true, checked: true },
      { key: "warehouses", label: "仓库", result: "api_code_190", passed: false, checked: true },
    ]);

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
    expect(result.lastJobRuns.find((row) => row.job === "connector-probe")).toMatchObject({
      job: "connector-probe",
      ok: false,
      message: "认证或授权异常（详情仅限受控日志）",
    });
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
