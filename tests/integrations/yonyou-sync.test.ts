/**
 * 用友只读观测同步测试。
 *
 * 该模块**刻意不做字段映射**：落地时 8 条契约在控制台全部未授权（310037），
 * 从未见过真实响应结构，凭想象写解析器就是把猜测伪装成实现。
 * 所以测试钉的是"不猜也要正确"的那部分：
 *   - 未授权是正常中间态，不抛错、不推进 checkpoint、如实标记；
 *   - 认不出分页结构时**整包原样落库**，绝不丢数据；
 *   - 原始字段一字不改地保留（将来写映射的依据）；
 *   - 真实成功幂等重放不重复外呼；授权等待保留状态且允许安全重试。
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { YonyouApiError, YonyouClient } from "@/server/integrations/yonyou-client";
import type { YonyouOpenApiConfig } from "@/server/integrations/yonyou";
import {
  extractRecordArray,
  profileYonyouFields,
  syncYonyouContract,
  yonyouShapeFingerprint,
} from "@/server/integrations/yonyou-sync";
import { loadStagedRows } from "@/server/modules/release/engine/common";
import { createTestDb } from "../helpers/db";

const CONFIG: YonyouOpenApiConfig = {
  appKey: "k", appSecret: "s", tenantId: "t", orgId: "o",
  productProfile: "c4",
  approvedApiContracts: ["物料档案分页查询 V2", "存货成本查询"],
  allowedHosts: ["c4.yonyoucloud.com"],
  baseUrl: "https://c4.yonyoucloud.com/iuap-api-gateway",
  tokenUrl: "https://c4.yonyoucloud.com/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken",
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

const TOKEN_OK = { code: "00000", data: { expire: 7200, access_token: "tok" } };
const testClients: Awaited<ReturnType<typeof createTestDb>>["client"][] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(testClients.splice(0).map((client) => client.close()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clientReturning(bizBody: unknown) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).includes("getAccessToken")) return json(TOKEN_OK);
    return json(bizBody);
  });
  return {
    // 注入 DNS 桩：出站防重绑守卫会真的解析域名，不注入的话挂 VPN/断网时
    // 每条用例卡满 30 秒超时（本轮实测 4/4 失败）。地址须是真公网段。
    client: new YonyouClient(CONFIG, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      retries: 0,
      dnsLookup: async () => [{ address: "121.199.0.1", family: 4 }],
    }),
    fetchMock,
  };
}

async function seedActor() {
  const { db, client } = await createTestDb();
  testClients.push(client);
  const [user] = await db.insert(schema.users).values({
    username: "yy_sync", name: "用友同步", passwordHash: "x", active: true,
  }).returning();
  return { db, actorId: user.id };
}

describe("用友只读观测同步", () => {
  it("vendor failure persists only code and recovery context; no checkpoint/job is invented", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "999998", message: "SYNTH_VENDOR_PRIVATE_UNLABELLED" });
    await expect(syncYonyouContract(db, { client, actorId, contract: "存货成本查询", scopeKey: "privacy" }))
      .rejects.toThrow("999998");
    const [run] = await db.select().from(schema.integrationRuns);
    expect(run).toMatchObject({ status: "failed", importJobId: null });
    expect(run.error).toContain("999998");
    expect(JSON.stringify(run)).not.toContain("SYNTH_VENDOR_PRIVATE");
    expect(await db.select().from(schema.integrationCheckpoints)).toHaveLength(0);
    expect(await db.select().from(schema.importJobs)).toHaveLength(0);
  });

  it("正常响应：原样落 staging，写 run/checkpoint 与证据哈希", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({
      code: "00000",
      data: { recordList: [{ code: "M001", name: "物料甲" }, { code: "M002", name: "物料乙" }] },
    });

    const summary = await syncYonyouContract(db, {
      client, contract: "物料档案分页查询 V2", actorId, scopeKey: "2026-08-04", sourceAsOf: "2026-08-04",
    });

    expect(summary.blockedByConsoleGrant).toBe(false);
    expect(summary.sourceRows).toBe(2);
    expect(summary.stagedRows).toBe(2);
    expect(summary.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.importJobId).not.toBeNull();

    const [job] = await db.select({ sourceAsOf: schema.importJobs.sourceAsOf })
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, summary.importJobId!));
    expect(job.sourceAsOf).toBe("2026-08-04");

    const rows = await db.select().from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, summary.importJobId!));
    expect(rows).toHaveLength(2);
    // 原始字段一字不改——将来写映射要靠它
    expect((rows[0].payload as { raw: unknown }).raw).toEqual({ code: "M001", name: "物料甲" });

    const [checkpoint] = await db.select().from(schema.integrationCheckpoints)
      .where(eq(schema.integrationCheckpoints.connector, "yy"));
    expect(checkpoint.cursor).toBe("2026-08-04");

    const [run] = await db.select({ requestScope: schema.integrationRuns.requestScope })
      .from(schema.integrationRuns)
      .where(eq(schema.integrationRuns.id, summary.runId));
    const scope = run.requestScope as { fieldProfile: unknown; sourceAsOf: string };
    expect(scope.sourceAsOf).toBe("2026-08-04");
    expect(scope.fieldProfile).toMatchObject({
      version: "yonyou-field-profile/v1",
      totalRecords: 2,
      sampledRecords: 2,
      fieldCount: 2,
      sensitiveFieldCount: 0,
      truncated: false,
    });
    const serializedProfile = JSON.stringify(scope.fieldProfile);
    expect(serializedProfile).not.toContain("M001");
    expect(serializedProfile).not.toContain("物料甲");
  });

  it("源业务日期与任意幂等 scope 分离，并在外呼前拒绝无效日期", async () => {
    const { db, actorId } = await seedActor();
    const { client, fetchMock } = clientReturning({ code: "00000", data: { recordList: [] } });

    await expect(syncYonyouContract(db, {
      client,
      contract: "物料档案分页查询 V2",
      actorId,
      scopeKey: "manual-replay-1",
      sourceAsOf: "2026-02-30",
    })).rejects.toThrow("sourceAsOf 必须是有效的 YYYY-MM-DD");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("310037 未授权：不抛错、不推进 checkpoint、如实标记等待控制台授权", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({
      code: "310037", message: "API未被授权：APPKEY[x]未获得要调用的API[/y]的授权",
    });

    const summary = await syncYonyouContract(db, {
      client, contract: "存货成本查询", actorId, scopeKey: "2026-08-04",
    });

    expect(summary.blockedByConsoleGrant, "等授权是正常中间态，不该当故障").toBe(true);
    expect(summary.stagedRows).toBe(0);
    expect(summary.importJobId).toBeNull();

    const checkpoints = await db.select().from(schema.integrationCheckpoints)
      .where(eq(schema.integrationCheckpoints.connector, "yy"));
    expect(checkpoints, "未取到数据不得推进 checkpoint").toHaveLength(0);
  });

  it("同 scope 仍未授权时再次检查，不能把旧等待记录重放成已接通", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "310037", message: "API未被授权" });
    const call = vi.spyOn(client, "callContract");
    const options = { client, contract: "存货成本查询" as const, actorId, scopeKey: "grant-repeat" };
    const first = await syncYonyouContract(db, options);
    const second = await syncYonyouContract(db, options);
    expect(second).toMatchObject({ runId: first.runId, replayed: false, blockedByConsoleGrant: true, importJobId: null });
    expect(call).toHaveBeenCalledTimes(2);
    expect(await db.select().from(schema.integrationRuns)).toHaveLength(1);
    expect(await db.select().from(schema.importJobs)).toHaveLength(0);
    expect(await db.select().from(schema.stagingRows)).toHaveLength(0);
    expect(await db.select().from(schema.integrationCheckpoints)).toHaveLength(0);
  });

  it("授权恢复后同 scope 可取数，之后真实成功仍幂等重放", async () => {
    const { db, actorId } = await seedActor();
    const denied = clientReturning({ code: "310005", message: "API未被授权" });
    const options = { contract: "存货成本查询" as const, actorId, scopeKey: "grant-recover" };
    const blocked = await syncYonyouContract(db, { ...options, client: denied.client });
    const { client } = clientReturning({ code: "00000", data: { rows: [{ code: "M001" }] } });
    const call = vi.spyOn(client, "callContract");
    const recovered = await syncYonyouContract(db, { ...options, client });
    expect(recovered).toMatchObject({ runId: blocked.runId, replayed: false, blockedByConsoleGrant: false, sourceRows: 1, stagedRows: 1 });
    expect(recovered.importJobId).not.toBeNull();
    const replay = await syncYonyouContract(db, { ...options, client });
    expect(replay).toMatchObject({ runId: recovered.runId, importJobId: recovered.importJobId, replayed: true, blockedByConsoleGrant: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.importJobs)).toHaveLength(1);
    expect(await db.select().from(schema.stagingRows)).toHaveLength(1);
    const [run] = await db.select().from(schema.integrationRuns);
    expect(run).toMatchObject({ status: "succeeded", error: null, importJobId: recovered.importJobId });
    const [checkpoint] = await db.select().from(schema.integrationCheckpoints);
    expect(checkpoint).toMatchObject({ lastRunId: recovered.runId, cursor: options.scopeKey, version: 1 });
  });

  it.each(["yy", "yonyou"])("较新 scope 仅等待授权，不得阻止旧 scope 恢复；较新 %s 真实成功仍阻止旧覆盖", async (connector) => {
    const { db, actorId } = await seedActor();
    const denied = clientReturning({ code: "310037", message: "API未被授权" });
    const base = { client: denied.client, contract: "存货成本查询" as const, actorId };
    const old = await syncYonyouContract(db, { ...base, scopeKey: "old-grant" });
    await syncYonyouContract(db, { ...base, scopeKey: "new-grant" });
    const { client } = clientReturning({ code: "00000", data: { rows: [{ code: "M001" }] } });
    const recovered = await syncYonyouContract(db, { ...base, client, scopeKey: "old-grant" });
    expect(recovered).toMatchObject({ runId: old.runId, replayed: false, sourceRows: 1 });
    const next = await syncYonyouContract(db, { ...base, scopeKey: "another-old-grant" });
    const latest = await syncYonyouContract(db, { ...base, client, scopeKey: "newest-real-success" });
    await db.update(schema.integrationRuns).set({ connector }).where(eq(schema.integrationRuns.id, latest.runId));
    await expect(syncYonyouContract(db, { ...base, client, scopeKey: "another-old-grant" }))
      .rejects.toThrow("已有更新成功运行");
    const [rejected] = await db.select().from(schema.integrationRuns).where(eq(schema.integrationRuns.id, next.runId));
    expect(rejected.status).toBe("failed");
    const [checkpoint] = await db.select().from(schema.integrationCheckpoints);
    expect(checkpoint.lastRunId).toBe(latest.runId);
    expect(await db.select().from(schema.importJobs)).toHaveLength(2);
  });

  it("授权恢复的并发重试只能由一个租约外呼，不能重复 staging", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "310037", message: "API未被授权" });
    const options = { client, contract: "存货成本查询" as const, actorId, scopeKey: "grant-concurrent" };
    await syncYonyouContract(db, options);
    const started = deferred<void>();
    const response = deferred<Record<string, unknown>>();
    const call = vi.spyOn(client, "callContract").mockImplementation(() => { started.resolve(); return response.promise; });
    const winner = syncYonyouContract(db, options);
    // Race a completion too, so the pre-fix false replay fails immediately instead of timing out.
    await Promise.race([started.promise, winner]);
    try {
      expect(call).toHaveBeenCalledTimes(1);
      await expect(syncYonyouContract(db, options)).rejects.toThrow("同步已被其他运行占用");
    } finally {
      response.resolve({ rows: [{ code: "M001" }] });
      await winner;
    }
    expect(call).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.importJobs)).toHaveLength(1);
    expect(await db.select().from(schema.stagingRows)).toHaveLength(1);
  });

  it.each(["授权拒绝", "成功"] as const)("相同毫秒重试也换租约；失去租约的%s不能覆盖新的成功结果", async (lateResult) => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "310037", message: "API未被授权" });
    const options = { client, contract: "存货成本查询" as const, actorId, scopeKey: "grant-fencing" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T01:00:00.000Z"));
    const blocked = await syncYonyouContract(db, options);
    const [before] = await db.select().from(schema.integrationRuns);
    const started = deferred<void>();
    const response = deferred<Record<string, unknown>>();
    vi.spyOn(client, "callContract").mockImplementation(() => { started.resolve(); return response.promise; });
    const pending = syncYonyouContract(db, options);
    const pendingOutcome = pending.then(() => null, (error: unknown) => error);
    await Promise.race([started.promise, pendingOutcome]);
    try {
      const [running] = await db.select().from(schema.integrationRuns);
      expect(running.status).toBe("running");
      expect(running.startedAt.getTime()).toBeGreaterThan(before.startedAt.getTime());
      vi.setSystemTime(new Date("2026-09-06T04:00:00.000Z"));
      const recovery = clientReturning({ code: "00000", data: { rows: [{ code: "M001" }] } });
      const recovered = await syncYonyouContract(db, { ...options, client: recovery.client });
      expect(recovered.runId).toBe(blocked.runId);
      if (lateResult === "授权拒绝") response.reject(new YonyouApiError("310037", options.contract));
      else response.resolve({ rows: [{ code: "LATE-MUST-NOT-REPLACE" }] });
      expect(await pendingOutcome).toBeInstanceOf(Error);
      expect(String(await pendingOutcome)).toContain("租约已被其他重试接管");
      const [final] = await db.select().from(schema.integrationRuns);
      expect(final).toMatchObject({ status: "succeeded", error: null, importJobId: recovered.importJobId, sourceRows: 1 });
      expect(await db.select().from(schema.importJobs)).toHaveLength(1);
      const rows = await db.select().from(schema.stagingRows);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ raw: { code: "M001" } });
      const [checkpoint] = await db.select().from(schema.integrationCheckpoints);
      expect(checkpoint).toMatchObject({ lastRunId: recovered.runId, version: 1 });
    } finally {
      response.reject(new Error("test cleanup"));
      await response.promise.catch(() => undefined);
      await pendingOutcome;
    }
  });

  it.each(["failed", "running"] as const)("%s 失败或过期租约重领时清除旧结果，之后授权等待仍可恢复", async (status) => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "310037", message: "API未被授权" });
    const options = { client, contract: "存货成本查询" as const, actorId, scopeKey: `residual-${status}` };
    const first = await syncYonyouContract(db, options);
    await db.update(schema.integrationRuns).set({
      status, startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      finishedAt: status === "running" ? null : new Date(),
      evidenceHash: "old-hash", evidencePath: "old-path", requestScope: { schemaDrift: true },
      sourceRows: 7, stagedRows: 5, rejectedRows: 2, cursorStart: "old-start", cursorEnd: "old-end",
    }).where(eq(schema.integrationRuns.id, first.runId));
    const blocked = await syncYonyouContract(db, options);
    expect(blocked).toMatchObject({ runId: first.runId, replayed: false, blockedByConsoleGrant: true });
    const [run] = await db.select().from(schema.integrationRuns);
    expect(run).toMatchObject({
      evidenceHash: null, evidencePath: null, requestScope: null, sourceRows: 0, stagedRows: 0,
      rejectedRows: 0, cursorStart: null, cursorEnd: null, importJobId: null,
    });
    const recovery = clientReturning({ code: "00000", data: { rows: [{ code: "M001" }] } });
    const recovered = await syncYonyouContract(db, { ...options, client: recovery.client });
    expect(recovered).toMatchObject({ runId: first.runId, blockedByConsoleGrant: false, sourceRows: 1 });
    expect(await db.select().from(schema.importJobs)).toHaveLength(1);
  });

  it.each([
    { error: null },
    { error: "无法确认的旧错误" },
    { error: "待控制台授权：other" },
    { sourceRows: 1 },
    { stagedRows: 1 },
    { rejectedRows: 1 },
    { evidenceHash: "existing-evidence" },
    { evidencePath: "existing-evidence-path" },
  ])("成功标记但无观察 job 的矛盾结果保留待核对，不自动重拉：%j", async (patch) => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "310037", message: "API未被授权" });
    const options = { client, contract: "存货成本查询" as const, actorId, scopeKey: "inconsistent-run" };
    const first = await syncYonyouContract(db, options);
    await db.update(schema.integrationRuns).set(patch).where(eq(schema.integrationRuns.id, first.runId));
    const [before] = await db.select().from(schema.integrationRuns);
    const call = vi.spyOn(client, "callContract");
    await expect(syncYonyouContract(db, options)).rejects.toThrow("成功状态与观察证据不一致");
    expect(call).not.toHaveBeenCalled();
    expect(await db.select().from(schema.integrationRuns)).toEqual([before]);
    expect(await db.select().from(schema.importJobs)).toHaveLength(0);
    expect(await db.select().from(schema.integrationCheckpoints)).toHaveLength(0);
  });

  it("已有真实 job 却带错误的成功记录不伪装健康、不清除观察数据", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "00000", data: { rows: [{ code: "M001" }] } });
    const options = { client, contract: "存货成本查询" as const, actorId, scopeKey: "inconsistent-job" };
    const first = await syncYonyouContract(db, options);
    await db.update(schema.integrationRuns).set({ error: "待控制台授权：310037" }).where(eq(schema.integrationRuns.id, first.runId));
    const beforeRows = await db.select().from(schema.stagingRows);
    const call = vi.spyOn(client, "callContract");
    await expect(syncYonyouContract(db, options)).rejects.toThrow("成功状态与观察证据不一致");
    expect(call).not.toHaveBeenCalled();
    expect(await db.select().from(schema.stagingRows)).toEqual(beforeRows);
    expect(await db.select().from(schema.importJobs)).toHaveLength(1);
  });

  it("矛盾的成功记录不得成为结构基线，仍使用最后一个可信基线", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "00000", data: { rows: [{ code: "M001" }] } });
    const base = { client, contract: "存货成本查询" as const, actorId };
    const trusted = await syncYonyouContract(db, { ...base, scopeKey: "trusted-baseline" });
    const inconsistent = await syncYonyouContract(db, { ...base, scopeKey: "inconsistent-baseline" });
    const [row] = await db.select().from(schema.integrationRuns).where(eq(schema.integrationRuns.id, inconsistent.runId));
    await db.update(schema.integrationRuns).set({
      error: "待控制台授权：310037",
      requestScope: { ...(row.requestScope as Record<string, unknown>), shapeFingerprint: "untrusted-shape" },
    }).where(eq(schema.integrationRuns.id, inconsistent.runId));
    const next = await syncYonyouContract(db, { ...base, scopeKey: "after-inconsistent-baseline" });
    expect(next.schemaDrift).toBe(false);
    const [nextRun] = await db.select().from(schema.integrationRuns).where(eq(schema.integrationRuns.id, next.runId));
    expect(nextRun.requestScope).toMatchObject({ schemaBaselineRunId: trusted.runId });
  });

  it("真实空响应已有观察 job，不能误作等待授权反复取数", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "00000", data: { rows: [] } });
    const call = vi.spyOn(client, "callContract");
    const options = { client, contract: "存货成本查询" as const, actorId, scopeKey: "real-empty" };
    const first = await syncYonyouContract(db, options);
    const second = await syncYonyouContract(db, options);
    expect(first).toMatchObject({ sourceRows: 0, stagedRows: 0, blockedByConsoleGrant: false });
    expect(first.importJobId).not.toBeNull();
    expect(second).toMatchObject({ importJobId: first.importJobId, replayed: true, blockedByConsoleGrant: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.importJobs)).toHaveLength(1);
  });

  it("认不出分页结构时整包原样落一行，绝不丢数据", async () => {
    const { db, actorId } = await seedActor();
    // 用友各接口外层结构不一，这里给一个我们没见过的形状
    const { client } = clientReturning({
      code: "00000",
      data: { 某个未知包裹: { 明细: [{ a: 1 }] }, total: 1 },
    });

    const summary = await syncYonyouContract(db, {
      client, contract: "存货成本查询", actorId, scopeKey: "unknown-shape",
    });

    expect(summary.stagedRows).toBe(1);
    const rows = await db.select().from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, summary.importJobId!));
    expect((rows[0].payload as { raw: Record<string, unknown> }).raw).toHaveProperty("某个未知包裹");
  });

  it("同 scopeKey 重放直接返回上次结果，不重复外呼", async () => {
    const { db, actorId } = await seedActor();
    const { client, fetchMock } = clientReturning({
      code: "00000", data: { rows: [{ code: "M001" }] },
    });

    await syncYonyouContract(db, {
      client, contract: "物料档案分页查询 V2", actorId, scopeKey: "same-key",
    });
    const callsAfterFirst = fetchMock.mock.calls.length;

    const replay = await syncYonyouContract(db, {
      client, contract: "物料档案分页查询 V2", actorId, scopeKey: "same-key",
    });

    expect(replay.replayed).toBe(true);
    expect(fetchMock.mock.calls.length, "重放不应再打接口").toBe(callsAfterFirst);
  });

  it("结构漂移持续阻断放行，连续返回同一新结构也不会自动建立新基线", async () => {
    const { db, actorId } = await seedActor();
    const baselineClient = clientReturning({
      code: "00000", data: { rows: [{ code: "M001", name: "物料甲" }] },
    }).client;
    const sameShapeClient = clientReturning({
      code: "00000", data: { rows: [{ code: "M002", name: "物料乙" }] },
    }).client;
    const changedClient = clientReturning({
      code: "00000", data: { rows: [{ code: "M003", name: "物料丙", mobile: "13800000000" }] },
    }).client;

    const baseline = await syncYonyouContract(db, {
      client: baselineClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "baseline",
    });
    expect(baseline).toMatchObject({ schemaDrift: false, releaseBlocked: false });

    const stable = await syncYonyouContract(db, {
      client: sameShapeClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "stable",
    });
    expect(stable).toMatchObject({ schemaDrift: false, releaseBlocked: false });

    const drift = await syncYonyouContract(db, {
      client: changedClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "drift-1",
    });
    expect(drift).toMatchObject({ schemaDrift: true, releaseBlocked: true });
    expect(drift.importJobId).not.toBeNull();

    const [job] = await db.select({ scope: schema.importJobs.scope })
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, drift.importJobId!));
    expect(job.scope).toMatchObject({
      schemaVersion: "yonyou-observation-v1",
      schemaDrift: true,
      schemaBaselineRunId: stable.runId,
      releaseBlocked: true,
    });
    await expect(loadStagedRows(db, "yonyou_observation", [drift.importJobId!]))
      .rejects.toThrow(/releaseBlocked，禁止进入正式放行引擎/);

    const stillDrift = await syncYonyouContract(db, {
      client: changedClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "drift-2",
    });
    expect(stillDrift).toMatchObject({ schemaDrift: true, releaseBlocked: true });
    const replay = await syncYonyouContract(db, {
      client: changedClient, contract: "物料档案分页查询 V2", actorId, scopeKey: "drift-1",
    });
    expect(replay).toMatchObject({ replayed: true, schemaDrift: true, releaseBlocked: true });
    expect(replay.shapeFingerprint).toBe(drift.shapeFingerprint);
  });

  it("未批准的契约拒绝同步（双重白名单的第二道）", async () => {
    const { db, actorId } = await seedActor();
    const { client } = clientReturning({ code: "00000", data: {} });

    await expect(syncYonyouContract(db, {
      client, contract: "凭证列表查询", actorId, scopeKey: "x",
    })).rejects.toThrow(/不在 YY_APPROVED_API_CONTRACTS 批准范围内/);
  });

  it("执行人不存在时拒绝同步（审计要有真实归属）", async () => {
    const { db } = await seedActor();
    const { client } = clientReturning({ code: "00000", data: {} });

    await expect(syncYonyouContract(db, {
      client, contract: "存货成本查询", actorId: 99999, scopeKey: "x",
    })).rejects.toThrow(/执行人 99999 不存在/);
  });
});

describe("响应结构工具", () => {
  it("结构指纹只看键的形状，与具体值无关", () => {
    const a = yonyouShapeFingerprint({ code: "M001", qty: 1 });
    const b = yonyouShapeFingerprint({ code: "M999", qty: 42 });
    expect(a).toBe(b);
    expect(yonyouShapeFingerprint({ code: "x" })).not.toBe(a);
  });

  it("指纹区分数组与对象，且对空数组不臆断元素结构", () => {
    expect(yonyouShapeFingerprint({ rows: [] })).toBe("{rows:[]}");
    expect(yonyouShapeFingerprint({ rows: [{ a: 1 }] })).toBe("{rows:[{a:number}]}");
  });

  it("结构指纹联合数组内不同形状，且不受记录顺序影响", () => {
    const a = yonyouShapeFingerprint({ rows: [{ code: "M1" }, { code: "M2", name: "物料" }] });
    const b = yonyouShapeFingerprint({ rows: [{ code: "M2", name: "另一物料" }, { code: "M1" }] });
    expect(a).toBe(b);
    expect(a).toContain("{code:string,name:string}");
    expect(a).toContain("{code:string}");
  });

  it("字段画像只保留路径/类型/出现率与敏感分类，不复制业务值", () => {
    const profile = profileYonyouFields([
      {
        code: "M001",
        mobile: "13800000000",
        bankAccount: "6222000000000000",
        lines: [{ qty: 1 }],
      },
      {
        code: "M002",
        mobile: null,
        lines: [{ qty: "2", remark: "内部备注" }],
      },
    ]);

    expect(profile).toMatchObject({
      version: "yonyou-field-profile/v1",
      totalRecords: 2,
      sampledRecords: 2,
      sensitiveFieldCount: 2,
      sensitiveCategories: ["contact", "financial"],
      truncated: false,
    });
    expect(profile.fields.find((field) => field.path === "bankAccount")).toMatchObject({
      types: ["string"],
      presentInRecords: 1,
      optional: true,
      nullable: false,
      sensitiveCategory: "financial",
    });
    expect(profile.fields.find((field) => field.path === "mobile")).toMatchObject({
      types: ["null", "string"],
      presentInRecords: 2,
      optional: false,
      nullable: true,
      sensitiveCategory: "contact",
    });
    expect(profile.fields.find((field) => field.path === "lines[].remark")).toMatchObject({
      presentInRecords: 1,
      optional: true,
    });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain("13800000000");
    expect(serialized).not.toContain("6222000000000000");
    expect(serialized).not.toContain("内部备注");
  });

  it("字段画像有字段数上限，异常宽响应不会撑大运行元数据", () => {
    const record = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`field_${index}`, index]));
    const profile = profileYonyouFields([record]);
    expect(profile.fieldCount).toBe(256);
    expect(profile.truncated).toBe(true);
  });

  it("能在常见包裹键下找到记录数组", () => {
    expect(extractRecordArray({ recordList: [1, 2] })).toEqual([1, 2]);
    expect(extractRecordArray({ data: { rows: [3] } })).toEqual([3]);
  });

  it("认不出就返回 null，不硬凑", () => {
    expect(extractRecordArray({ 未知: { 更深: { rows: [1] } } })).toBeNull();
    expect(extractRecordArray({ total: 5 })).toBeNull();
  });
});
