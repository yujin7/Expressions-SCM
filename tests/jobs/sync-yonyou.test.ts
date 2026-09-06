/**
 * 用友同步调度入口测试。
 *
 * 纪律：配置缺失一律 skipped 且理由具体，绝不伪造成功；
 * 等控制台授权单列 awaitingConsoleGrant，不混进故障。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runYonyouSync, yonyouSyncActorId } from "@/jobs/sync-yonyou";
import { YonyouApiError, YonyouClient } from "@/server/integrations/yonyou-client";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { yonyouJobSummary } from "@/lib/yonyou-job-summary";

const KEYS = [
  "YY_APP_KEY", "YY_APP_SECRET", "YY_TENANT_ID", "YY_ORG_ID", "YY_PRODUCT_PROFILE",
  "YY_APPROVED_API_CONTRACTS", "YY_ALLOWED_HOSTS", "YY_BASE_URL", "YY_TOKEN_URL",
  "YY_SYNC_ENABLED", "YY_SYNC_ACTOR_ID",
] as const;
const original = new Map(KEYS.map((key) => [key, process.env[key]]));
const clients: Awaited<ReturnType<typeof createTestDb>>["client"][] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const key of KEYS) {
    const value = original.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function fullConfig(): void {
  process.env.YY_APP_KEY = "k";
  process.env.YY_APP_SECRET = "s";
  process.env.YY_TENANT_ID = "t";
  process.env.YY_ORG_ID = "o";
  process.env.YY_PRODUCT_PROFILE = "c4";
  process.env.YY_APPROVED_API_CONTRACTS = "存货成本查询";
  process.env.YY_ALLOWED_HOSTS = "c4.yonyoucloud.com";
  process.env.YY_BASE_URL = "https://c4.yonyoucloud.com/iuap-api-gateway";
  process.env.YY_TOKEN_URL = "https://c4.yonyoucloud.com/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken";
}

async function enabledFixture(contracts = "存货成本查询") {
  const { db, client } = await createTestDb();
  clients.push(client);
  const [actor] = await db.insert(schema.users).values({ name: "用友测试执行人", active: true }).returning();
  fullConfig();
  process.env.YY_SYNC_ENABLED = "true";
  process.env.YY_SYNC_ACTOR_ID = String(actor.id);
  process.env.YY_APPROVED_API_CONTRACTS = contracts;
  return db;
}

describe("用友同步调度入口", () => {
  it("全部等待授权及同范围重试均保持等待；不把执行完成冒充读取成功", async () => {
    const db = await enabledFixture();
    const call = vi.spyOn(YonyouClient.prototype, "callContract").mockRejectedValue(
      new YonyouApiError("310037", "合成授权拒绝", "存货成本查询"),
    );
    for (let i = 0; i < 2; i++) {
      expect(await runYonyouSync(db, "2026-08-04")).toMatchObject({
        status: "awaiting_authorization", awaitingConsoleGrant: ["存货成本查询"],
        results: [{ blockedByConsoleGrant: true, replayed: false, importJobId: null }],
      });
    }
    expect(call).toHaveBeenCalledTimes(2);
    expect(await db.select().from(schema.integrationRuns)).toHaveLength(1);
    expect(await db.select().from(schema.importJobs)).toHaveLength(0);
    expect(await db.select().from(schema.integrationCheckpoints)).toHaveLength(0);
  });

  it("部分授权保留真实读取；同范围只重试等待契约，恢复后才汇总成功", async () => {
    const db = await enabledFixture("物料档案分页查询 V2,存货成本查询");
    let authorized = false;
    const call = vi.spyOn(YonyouClient.prototype, "callContract").mockImplementation(async (contract) => {
      if (contract === "存货成本查询" && !authorized) throw new YonyouApiError("310005", "合成授权拒绝", contract);
      return { rows: [{ code: "M001" }] };
    });
    const first = await runYonyouSync(db, "2026-08-04");
    expect(first).toMatchObject({ status: "partial", awaitingConsoleGrant: ["存货成本查询"] });
    expect(yonyouJobSummary(first)).toMatchObject({ status: "partial", total: 2, readable: 1, waiting: 1 });
    expect(await db.select().from(schema.importJobs)).toHaveLength(1);
    const retry = await runYonyouSync(db, "2026-08-04");
    expect(retry).toMatchObject({ status: "partial", results: [
      { blockedByConsoleGrant: false, replayed: true, stagedRows: 1 },
      { blockedByConsoleGrant: true, replayed: false, stagedRows: 0 },
    ] });
    expect(call).toHaveBeenCalledTimes(3);
    authorized = true;
    const recovered = await runYonyouSync(db, "2026-08-04");
    expect(recovered).toMatchObject({ status: "succeeded", awaitingConsoleGrant: [] });
    expect(yonyouJobSummary(recovered)).toMatchObject({ status: "succeeded", total: 2, readable: 2, waiting: 0 });
    expect(call).toHaveBeenCalledTimes(4);
    expect(await db.select().from(schema.importJobs)).toHaveLength(2);
    expect(await db.select().from(schema.stagingRows)).toHaveLength(2);
    expect(await db.select().from(schema.integrationCheckpoints)).toHaveLength(2);
    expect(await runYonyouSync(db, "2026-08-04")).toMatchObject({ status: "succeeded" });
    expect(call).toHaveBeenCalledTimes(4);
  });

  it("真正空响应属于读取完成，不以零行推断等待授权", async () => {
    const db = await enabledFixture();
    vi.spyOn(YonyouClient.prototype, "callContract").mockResolvedValue({ rows: [] });
    expect(await runYonyouSync(db, "2026-08-04")).toMatchObject({
      status: "succeeded", awaitingConsoleGrant: [], results: [{ sourceRows: 0, blockedByConsoleGrant: false }],
    });
    expect(await db.select().from(schema.importJobs)).toHaveLength(1);
  });

  it("机器配置不完整时跳过，理由具体且不伪造成功", async () => {
    for (const key of KEYS) delete process.env[key];
    const result = await runYonyouSync({} as never, "2026-08-04");
    expect(result.status).toBe("skipped");
    expect(result).toMatchObject({ reason: expect.stringContaining("机器配置不完整") });
  });

  it("配置齐全但开关未开时跳过", async () => {
    fullConfig();
    delete process.env.YY_SYNC_ENABLED;
    const result = await runYonyouSync({} as never, "2026-08-04");
    expect(result).toMatchObject({ status: "skipped", reason: "YY_SYNC_ENABLED 未开启" });
  });

  it("缺少有效执行人时跳过——审计不能记到 0 号用户头上", async () => {
    fullConfig();
    process.env.YY_SYNC_ENABLED = "true";
    delete process.env.YY_SYNC_ACTOR_ID;
    const result = await runYonyouSync({} as never, "2026-08-04");
    expect(result).toMatchObject({ status: "skipped", reason: "缺少有效 YY_SYNC_ACTOR_ID" });
  });

  it("执行人 ID 必须是正整数，非法值不被采纳", () => {
    expect(yonyouSyncActorId({ YY_SYNC_ACTOR_ID: "3" } as unknown as NodeJS.ProcessEnv)).toBe(3);
    expect(yonyouSyncActorId({ YY_SYNC_ACTOR_ID: "0" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(yonyouSyncActorId({ YY_SYNC_ACTOR_ID: "-1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(yonyouSyncActorId({ YY_SYNC_ACTOR_ID: "abc" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(yonyouSyncActorId({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
