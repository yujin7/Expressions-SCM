/**
 * 用友同步调度入口测试。
 *
 * 纪律：配置缺失一律 skipped 且理由具体，绝不伪造成功；
 * 等控制台授权单列 awaitingConsoleGrant，不混进故障。
 */
import { afterEach, describe, expect, it } from "vitest";
import { runYonyouSync, yonyouSyncActorId } from "@/jobs/sync-yonyou";

const KEYS = [
  "YY_APP_KEY", "YY_APP_SECRET", "YY_TENANT_ID", "YY_ORG_ID", "YY_PRODUCT_PROFILE",
  "YY_APPROVED_API_CONTRACTS", "YY_ALLOWED_HOSTS", "YY_BASE_URL", "YY_TOKEN_URL",
  "YY_SYNC_ENABLED", "YY_SYNC_ACTOR_ID",
] as const;
const original = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
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

describe("用友同步调度入口", () => {
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
