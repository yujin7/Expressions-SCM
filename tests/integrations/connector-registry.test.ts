import { afterEach, describe, expect, it } from "vitest";
import {
  configuredConnectors, CONNECTORS, getConnectorReadiness,
} from "@/server/integrations/connector";

const envKeys = [
  "JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN", "JST_SYNC_ACTOR_ID", "JST_BASE_URL",
  "JST_INVENTORY_SYNC_ENABLED", "JST_LIVE_VERIFIED_AT", "JST_LIVE_VERIFIED_REF",
  "JIANDAOYUN_API_KEY", "JIANDAOYUN_SYNC_ACTOR_ID", "JIANDAOYUN_SYNC_ENABLED",
  "JIANDAOYUN_SYNC_CONTRACTS", "JIANDAOYUN_BASE_URL", "JIANDAOYUN_LIVE_VERIFIED_AT",
  "JIANDAOYUN_LIVE_VERIFIED_REF",
  "YY_APP_KEY", "YY_APP_SECRET",
  "YY_CLIENT_ID", "YY_CLIENT_SECRET", "YY_TENANT_ID", "YY_ORG_ID", "YY_BASE_URL", "YY_TOKEN_URL",
  "YY_PRODUCT_PROFILE", "YY_APPROVED_API_CONTRACTS",
  "YY_ALLOWED_HOSTS",
  "FEISHU_WEBHOOK_URL", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID",
  "FEISHU_LIVE_VERIFIED_AT", "FEISHU_LIVE_VERIFIED_REF",
] as const;
const original = new Map(envKeys.map((key) => [key, process.env[key]]));
const NOW = new Date("2026-07-30T12:00:00Z");

afterEach(() => {
  for (const key of envKeys) {
    const value = original.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("外部连接器目录", () => {
  it("登记真实目标系统；JST 凭据齐全只代表可运行，真实 UAT 后才可标 operational", () => {
    expect(CONNECTORS.map((connector) => connector.key)).toEqual(["jst", "jdy", "yy", "feishu"]);
    process.env.JST_APP_KEY = "present";
    process.env.JST_APP_SECRET = "present";
    process.env.JST_ACCESS_TOKEN = "present";
    process.env.JST_SYNC_ACTOR_ID = "3";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")).toMatchObject({
      implementation: "ready",
      configured: true,
      operational: false,
      auth: "signed_token",
      missingEnv: [],
      liveVerifiedAt: null,
      liveVerificationState: "missing",
    });
    expect(configuredConnectors().some((connector) => connector.key === "jst")).toBe(true);
    process.env.JST_BASE_URL = "https://openapi.jushuitan.com.evil.example";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")).toMatchObject({
      configured: false,
      operational: false,
      missingEnv: ["JST_BASE_URL"],
    });
    delete process.env.JST_BASE_URL;
    process.env.JST_LIVE_VERIFIED_AT = "2026-07-29T00:00:00Z";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")).toMatchObject({
      operational: false,
      liveVerifiedAt: "2026-07-29T00:00:00.000Z",
      liveVerificationState: "missing_evidence",
    });
    process.env.JST_LIVE_VERIFIED_REF = "UAT-20260729-JST-001";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")).toMatchObject({
      operational: true,
      liveVerifiedAt: "2026-07-29T00:00:00.000Z",
      liveVerificationRef: "UAT-20260729-JST-001",
      liveVerificationState: "valid",
    });
  });

  it("简道云凭据和责任人只代表 configured，未做控制总量 UAT 不标 operational", () => {
    process.env.JIANDAOYUN_API_KEY = "present";
    process.env.JIANDAOYUN_SYNC_ACTOR_ID = "3";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      implementation: "ready",
      configured: true,
      operational: false,
      auth: "api_key",
      missingEnv: [],
      liveVerifiedAt: null,
    });
    expect(configuredConnectors().some((connector) => connector.key === "jdy")).toBe(true);
    process.env.JIANDAOYUN_LIVE_VERIFIED_AT = "2026-07-30T01:00:00Z";
    process.env.JIANDAOYUN_LIVE_VERIFIED_REF = "UAT-20260730-JDY-001";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      operational: true,
      liveVerifiedAt: "2026-07-30T01:00:00.000Z",
      liveVerificationState: "valid",
    });
    process.env.JIANDAOYUN_BASE_URL = "http://api.example.invalid";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      configured: false,
      operational: false,
      missingEnv: ["JIANDAOYUN_BASE_URL"],
    });
  });

  it("飞书 webhook 或应用机器人任一路径完整即可运行，但不伪装成已完成 live UAT", () => {
    process.env.FEISHU_WEBHOOK_URL =
      "https://open.feishu.cn/open-apis/bot/v2/hook/test-connector";
    expect(configuredConnectors().map((connector) => connector.key)).toContain("feishu");
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configured: true,
      operational: false,
      liveVerifiedAt: null,
    });
    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-07-29T01:00:00Z";
    process.env.FEISHU_LIVE_VERIFIED_REF = "UAT-20260729-FEISHU-001";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      operational: true,
      liveVerifiedAt: "2026-07-29T01:00:00.000Z",
      liveVerificationState: "valid",
    });
    process.env.FEISHU_WEBHOOK_URL = "https://attacker.example/webhook";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configured: false,
      operational: false,
      missingEnv: [
        "FEISHU_WEBHOOK_URL",
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
        "FEISHU_CHAT_ID",
      ],
    });
    delete process.env.FEISHU_WEBHOOK_URL;
    delete process.env.FEISHU_LIVE_VERIFIED_AT;
    process.env.FEISHU_APP_ID = "app";
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.FEISHU_CHAT_ID = "chat";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configured: true,
      operational: false,
      missingEnv: [],
    });
  });

  it("用友人工账号不构成机器配置；完整 OpenAPI 契约仍保持 contract_only", () => {
    for (const key of [
      "YY_APP_KEY", "YY_APP_SECRET", "YY_TENANT_ID", "YY_ORG_ID",
    ] as const) process.env[key] = "present";
    process.env.YY_PRODUCT_PROFILE = "yonsuite";
    process.env.YY_APPROVED_API_CONTRACTS = "supplier.read@v1,cost.read@v1";
    process.env.YY_ALLOWED_HOSTS = "api.yonyoucloud.com,auth.yonyoucloud.com";
    process.env.YY_BASE_URL = "https://api.yonyoucloud.com";
    process.env.YY_TOKEN_URL = "https://auth.yonyoucloud.com/token";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "yy")).toMatchObject({
      implementation: "contract_only",
      configured: true,
      operational: false,
      missingEnv: [],
    });
    expect(configuredConnectors().some((connector) => connector.key === "yy")).toBe(false);
    process.env.YY_TOKEN_URL = "http://auth.yonyoucloud.com/token";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "yy")).toMatchObject({
      configured: false,
      missingEnv: ["YY_TOKEN_URL"],
    });
  });

  it("live UAT 标记须有非秘密证据引用，且未来、非法或超过 90 天都不算 operational", () => {
    process.env.FEISHU_WEBHOOK_URL =
      "https://open.feishu.cn/open-apis/bot/v2/hook/test-connector";
    process.env.FEISHU_LIVE_VERIFIED_REF = "UAT-20260730-FEISHU-001";

    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-08-01T00:00:00Z";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "future" });

    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-04-01T00:00:00Z";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "stale" });

    process.env.FEISHU_LIVE_VERIFIED_AT = "not-a-date";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "invalid" });

    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-07-30junk";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "invalid" });

    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-02-30T01:00:00Z";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "invalid" });

    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-07-30T09:00:00+08:00";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({
        operational: true,
        liveVerificationState: "valid",
        liveVerifiedAt: "2026-07-30T01:00:00.000Z",
      });

    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-07-30T01:00:00Z";
    process.env.FEISHU_LIVE_VERIFIED_REF = "https://tracker.example/UAT?id=secret";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({
        operational: false,
        liveVerificationState: "invalid",
        liveVerificationRef: null,
      });
  });
});
