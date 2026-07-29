import { afterEach, describe, expect, it } from "vitest";
import {
  configuredConnectors, CONNECTORS, getConnectorReadiness,
} from "@/server/integrations/connector";

const envKeys = [
  "JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN", "JST_SYNC_ACTOR_ID",
  "YY_CLIENT_ID", "YY_CLIENT_SECRET", "YY_TENANT_ID", "YY_ORG_ID", "YY_BASE_URL", "YY_TOKEN_URL",
  "FEISHU_WEBHOOK_URL", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID",
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
  it("登记真实目标系统；JST 只有机器凭据与同步责任人都齐全才可运行", () => {
    expect(CONNECTORS.map((connector) => connector.key)).toEqual(["jst", "yy", "feishu"]);
    process.env.JST_APP_KEY = "present";
    process.env.JST_APP_SECRET = "present";
    process.env.JST_ACCESS_TOKEN = "present";
    process.env.JST_SYNC_ACTOR_ID = "3";
    expect(getConnectorReadiness().find((row) => row.key === "jst")).toMatchObject({
      implementation: "ready",
      configured: true,
      operational: true,
      auth: "signed_token",
      missingEnv: [],
    });
    expect(configuredConnectors().some((connector) => connector.key === "jst")).toBe(true);
  });

  it("飞书 webhook 或应用机器人任一路径完整即可运行", () => {
    process.env.FEISHU_WEBHOOK_URL = "https://example.invalid/webhook";
    expect(configuredConnectors().map((connector) => connector.key)).toContain("feishu");
    delete process.env.FEISHU_WEBHOOK_URL;
    process.env.FEISHU_APP_ID = "app";
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.FEISHU_CHAT_ID = "chat";
    expect(getConnectorReadiness().find((row) => row.key === "feishu")).toMatchObject({
      configured: true,
      operational: true,
      missingEnv: [],
    });
  });

  it("用友人工账号不构成机器配置；OpenAPI 六项齐全仍保持 contract_only", () => {
    for (const key of [
      "YY_CLIENT_ID", "YY_CLIENT_SECRET", "YY_TENANT_ID", "YY_ORG_ID", "YY_BASE_URL", "YY_TOKEN_URL",
    ] as const) process.env[key] = "present";
    expect(getConnectorReadiness().find((row) => row.key === "yy")).toMatchObject({
      implementation: "contract_only",
      configured: true,
      operational: false,
      missingEnv: [],
    });
    expect(configuredConnectors().some((connector) => connector.key === "yy")).toBe(false);
  });
});
