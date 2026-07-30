import { afterEach, describe, expect, it } from "vitest";
import {
  configuredConnectors, CONNECTORS, getConnectorReadiness,
} from "@/server/integrations/connector";

const envKeys = [
  "JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN", "JST_SYNC_ACTOR_ID",
  "JST_INVENTORY_SYNC_ENABLED", "JST_LIVE_VERIFIED_AT",
  "JIANDAOYUN_API_KEY", "JIANDAOYUN_SYNC_ACTOR_ID", "JIANDAOYUN_SYNC_ENABLED",
  "JIANDAOYUN_SYNC_CONTRACTS", "JIANDAOYUN_BASE_URL", "JIANDAOYUN_LIVE_VERIFIED_AT",
  "YY_APP_KEY", "YY_APP_SECRET",
  "YY_CLIENT_ID", "YY_CLIENT_SECRET", "YY_TENANT_ID", "YY_ORG_ID", "YY_BASE_URL", "YY_TOKEN_URL",
  "FEISHU_WEBHOOK_URL", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID",
  "FEISHU_LIVE_VERIFIED_AT",
] as const;
const original = new Map(envKeys.map((key) => [key, process.env[key]]));

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
    expect(getConnectorReadiness().find((row) => row.key === "jst")).toMatchObject({
      implementation: "ready",
      configured: true,
      operational: false,
      auth: "signed_token",
      missingEnv: [],
      liveVerifiedAt: null,
    });
    expect(configuredConnectors().some((connector) => connector.key === "jst")).toBe(true);
    process.env.JST_LIVE_VERIFIED_AT = "2026-07-29T00:00:00Z";
    expect(getConnectorReadiness().find((row) => row.key === "jst")).toMatchObject({
      operational: true,
      liveVerifiedAt: "2026-07-29T00:00:00.000Z",
    });
  });

  it("简道云凭据和责任人只代表 configured，未做控制总量 UAT 不标 operational", () => {
    process.env.JIANDAOYUN_API_KEY = "present";
    process.env.JIANDAOYUN_SYNC_ACTOR_ID = "3";
    expect(getConnectorReadiness().find((row) => row.key === "jdy")).toMatchObject({
      implementation: "ready",
      configured: true,
      operational: false,
      auth: "api_key",
      missingEnv: [],
      liveVerifiedAt: null,
    });
    expect(configuredConnectors().some((connector) => connector.key === "jdy")).toBe(true);
    process.env.JIANDAOYUN_LIVE_VERIFIED_AT = "2026-07-30T01:00:00Z";
    expect(getConnectorReadiness().find((row) => row.key === "jdy")).toMatchObject({
      operational: true,
      liveVerifiedAt: "2026-07-30T01:00:00.000Z",
    });
    process.env.JIANDAOYUN_BASE_URL = "http://api.example.invalid";
    expect(getConnectorReadiness().find((row) => row.key === "jdy")).toMatchObject({
      configured: false,
      operational: false,
      missingEnv: ["JIANDAOYUN_BASE_URL"],
    });
  });

  it("飞书 webhook 或应用机器人任一路径完整即可运行，但不伪装成已完成 live UAT", () => {
    process.env.FEISHU_WEBHOOK_URL = "https://example.invalid/webhook";
    expect(configuredConnectors().map((connector) => connector.key)).toContain("feishu");
    expect(getConnectorReadiness().find((row) => row.key === "feishu")).toMatchObject({
      configured: true,
      operational: false,
      liveVerifiedAt: null,
    });
    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-07-29T01:00:00Z";
    expect(getConnectorReadiness().find((row) => row.key === "feishu")).toMatchObject({
      operational: true,
      liveVerifiedAt: "2026-07-29T01:00:00.000Z",
    });
    delete process.env.FEISHU_WEBHOOK_URL;
    delete process.env.FEISHU_LIVE_VERIFIED_AT;
    process.env.FEISHU_APP_ID = "app";
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.FEISHU_CHAT_ID = "chat";
    expect(getConnectorReadiness().find((row) => row.key === "feishu")).toMatchObject({
      configured: true,
      operational: false,
      missingEnv: [],
    });
  });

  it("用友人工账号不构成机器配置；OpenAPI 六项齐全仍保持 contract_only", () => {
    for (const key of [
      "YY_APP_KEY", "YY_APP_SECRET", "YY_TENANT_ID", "YY_ORG_ID",
    ] as const) process.env[key] = "present";
    process.env.YY_BASE_URL = "https://api.example.invalid";
    process.env.YY_TOKEN_URL = "https://auth.example.invalid/token";
    expect(getConnectorReadiness().find((row) => row.key === "yy")).toMatchObject({
      implementation: "contract_only",
      configured: true,
      operational: false,
      missingEnv: [],
    });
    expect(configuredConnectors().some((connector) => connector.key === "yy")).toBe(false);
    process.env.YY_TOKEN_URL = "http://auth.example.invalid/token";
    expect(getConnectorReadiness().find((row) => row.key === "yy")).toMatchObject({
      configured: false,
      missingEnv: ["YY_TOKEN_URL"],
    });
  });
});
