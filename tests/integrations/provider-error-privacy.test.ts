import { describe, expect, it } from "vitest";
import { JstClient } from "@/server/integrations/jst";
import { YonyouClient } from "@/server/integrations/yonyou-client";

const PRIVATE = "SYNTH_VENDOR_PRIVATE_UNLABELLED";
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const yyConfig = {
  appKey: "qa", appSecret: "qa", tenantId: "qa", orgId: "qa", productProfile: "c4" as const,
  approvedApiContracts: ["存货成本查询"], allowedHosts: ["c4.yonyoucloud.com"],
  baseUrl: "https://c4.yonyoucloud.com/iuap-api-gateway",
  tokenUrl: "https://c4.yonyoucloud.com/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken",
};

describe("provider envelope errors never retain raw vendor prose", () => {
  it("JST preserves permission code without copying msg into message, stack or metadata", async () => {
    const client = new JstClient({ appKey: "qa", appSecret: "qa", accessToken: "qa" }, {
      retries: 0, fetchImpl: async () => response({ code: 190, msg: PRIVATE }),
    });
    const error = await client.queryWarehousesPage(1).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "JstApiError", code: 190, retryable: false });
    expect(String(error)).toContain("190");
    expect(String(error)).not.toContain(PRIVATE);
    expect(JSON.stringify(error)).not.toContain(PRIVATE);
    expect((error as Error).stack).not.toContain(PRIVATE);
  });

  it.each(["token", "contract", "malformed-code"])("Yonyou %s preserves recovery semantics without raw text", async (phase) => {
    const client = new YonyouClient(yyConfig, {
      retries: 0, dnsLookup: async () => [{ address: "121.199.0.1", family: 4 }],
      fetchImpl: async (url) => String(url).includes("getAccessToken") && phase !== "token"
        ? response({ code: "00000", data: { expire: 7200, access_token: "qa" } })
        : response({ code: phase === "malformed-code" ? PRIVATE : "310037", message: PRIVATE }),
    });
    const error = await client.callContract("存货成本查询").catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "YonyouApiError", code: phase === "malformed-code" ? "unknown" : "310037" });
    if (phase !== "malformed-code") expect(error).toMatchObject({ needsConsoleGrant: true, retryable: false });
    expect(String(error)).not.toContain(PRIVATE);
    expect(JSON.stringify(error)).not.toContain(PRIVATE);
    expect((error as Error).stack).not.toContain(PRIVATE);
  });

  it("Yonyou refused endpoint does not echo embedded credentials or query", async () => {
    const client = new YonyouClient({ ...yyConfig, tokenUrl: `https://user:${PRIVATE}@example.invalid/auth?value=${PRIVATE}` });
    const error = await client.getAccessToken().catch((e: unknown) => e);
    expect(String(error)).toContain("白名单");
    expect(String(error)).not.toContain(PRIVATE);
  });
});
