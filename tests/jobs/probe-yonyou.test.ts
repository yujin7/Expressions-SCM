import { describe, expect, it, vi } from "vitest";
import { runYonyouPermissionProbe } from "@/jobs/probe-yonyou";
import { YONYOU_READ_CONTRACTS } from "@/server/integrations/yonyou-contracts";
import { YonyouApiError } from "@/server/integrations/yonyou-client";

const env = {
  NODE_ENV: "test",
  YY_APP_KEY: "SECRET-APP",
  YY_APP_SECRET: "SECRET-APP-SECRET",
  YY_TENANT_ID: "SECRET-TENANT",
  YY_ORG_ID: "SECRET-ORG",
  YY_PRODUCT_PROFILE: "c4",
  YY_APPROVED_API_CONTRACTS: YONYOU_READ_CONTRACTS[0].name,
  YY_ALLOWED_HOSTS: "c4.yonyoucloud.com",
  YY_BASE_URL: "https://c4.yonyoucloud.com/iuap-api-gateway",
  YY_TOKEN_URL: "https://c4.yonyoucloud.com/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken",
} satisfies NodeJS.ProcessEnv;

describe("用友只读权限探针", () => {
  it("逐条测量 8 个只读契约，仅返回紧凑安全证据", async () => {
    const client = {
      getAccessToken: vi.fn(async () => "TOKEN-MUST-NOT-LEAK"),
      callContract: vi.fn(async (name: string) => {
        const index = YONYOU_READ_CONTRACTS.findIndex((contract) => contract.name === name);
        if (index >= 3) {
          throw new YonyouApiError("310037", name);
        }
        return {};
      }),
    };
    const result = await runYonyouPermissionProbe({ env, client });
    expect(result).toMatchObject({
      c: "yy",
      s: "partial",
      a: "validated",
      p: 3,
      t: 8,
      w: false,
    });
    expect(result.r).toEqual([
      "ok", "ok", "ok",
      "api_code_310037", "api_code_310037", "api_code_310037", "api_code_310037", "api_code_310037",
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of ["TOKEN-MUST-NOT-LEAK", "SECRET-APP", "SECRET-TENANT", "SECRET-ORG"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("token 失败时不再触发业务契约，也不返回原始错误", async () => {
    const client = {
      getAccessToken: vi.fn(async () => { throw new Error("raw token response with secret"); }),
      callContract: vi.fn(),
    };
    const result = await runYonyouPermissionProbe({ env, client });
    expect(result).toMatchObject({ s: "partial", a: "not_validated", p: 0, w: false });
    expect(result.r[0]).toBe("unexpected_response");
    expect(client.callContract).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("raw token response");
  });

  it("配置不完整时显式 skipped，不调外部网关", async () => {
    const client = { getAccessToken: vi.fn(), callContract: vi.fn() };
    const result = await runYonyouPermissionProbe({ env: { NODE_ENV: "test" }, client });
    expect(result).toMatchObject({ s: "skipped", a: "not_checked", p: 0, t: 8, w: false });
    expect(client.getAccessToken).not.toHaveBeenCalled();
  });

  it("缺租户/组织时仍可验证 token 与只读授权，但不伪造目标绑定", async () => {
    const client = {
      getAccessToken: vi.fn(async () => "safe-token"),
      callContract: vi.fn(async (name: string) => {
        throw new YonyouApiError("310037", name);
      }),
    };
    const { YY_TENANT_ID: _tenant, YY_ORG_ID: _org, ...withoutScope } = env;
    const result = await runYonyouPermissionProbe({ env: withoutScope, client });
    expect(result).toMatchObject({ s: "partial", a: "validated", p: 0, t: 8, b: null, w: false });
    expect(client.getAccessToken).toHaveBeenCalledOnce();
    expect(client.callContract).toHaveBeenCalledTimes(8);
  });
});
