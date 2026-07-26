import { afterEach, describe, expect, it } from "vitest";
import {
  configuredConnectors, CONNECTORS, getConnectorReadiness,
} from "@/server/integrations/connector";

const envKeys = [
  "JST_APP_KEY", "JST_APP_SECRET", "YY_CLIENT_ID", "YY_CLIENT_SECRET", "FEISHU_WEBHOOK_URL",
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
  it("登记真实目标系统且脚手架不会被当作可运行连接器", () => {
    expect(CONNECTORS.map((connector) => connector.key)).toEqual(["jst", "yy", "feishu"]);
    process.env.JST_APP_KEY = "present";
    process.env.JST_APP_SECRET = "present";
    expect(getConnectorReadiness().find((row) => row.key === "jst")).toMatchObject({
      implementation: "contract_only",
      configured: true,
      operational: false,
    });
    expect(configuredConnectors().some((connector) => connector.key === "jst")).toBe(false);
  });

  it("只有代码已接通且配置完整的连接器进入运行清单", () => {
    process.env.FEISHU_WEBHOOK_URL = "https://example.invalid/webhook";
    expect(configuredConnectors().map((connector) => connector.key)).toContain("feishu");
  });
});
