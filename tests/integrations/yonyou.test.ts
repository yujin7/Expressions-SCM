import { describe, expect, it } from "vitest";
import {
  isSafeYonyouEndpoint,
  parseYonyouApprovedApiContracts,
  parseYonyouProductProfile,
  yonyouConfigFromEnv,
  yonyouMissingEnv,
} from "@/server/integrations/yonyou";
import { auditYonyouReadiness } from "@/jobs/audit-yonyou";

function completeEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    YY_APP_KEY: "app-key",
    YY_APP_SECRET: "app-secret",
    YY_TENANT_ID: "tenant",
    YY_ORG_ID: "org",
    YY_PRODUCT_PROFILE: "yonsuite",
    YY_APPROVED_API_CONTRACTS: "supplier.read@v1, cost.read@v1,supplier.read@v1",
    YY_BASE_URL: "https://api.yonyoucloud.com/openapi",
    YY_TOKEN_URL: "https://auth.yonyoucloud.com/oauth/token",
  };
}

describe("用友 OpenAPI 前置契约", () => {
  it("只有产品、获批接口和公开 HTTPS 端点完整时才形成配置", () => {
    const env = completeEnv();
    expect(yonyouMissingEnv(env)).toEqual([]);
    expect(yonyouConfigFromEnv(env)).toMatchObject({
      productProfile: "yonsuite",
      approvedApiContracts: ["supplier.read@v1", "cost.read@v1"],
    });
    delete env.YY_PRODUCT_PROFILE;
    expect(yonyouConfigFromEnv(env)).toBeNull();
    expect(yonyouMissingEnv(env)).toContain("YY_PRODUCT_PROFILE");
  });

  it("拒绝可窃取机器凭据的非公开、不安全或带凭据端点", () => {
    for (const url of [
      "http://api.example.com/token",
      "https://localhost/token",
      "https://127.0.0.1/token",
      "https://10.1.2.3/token",
      "https://192.168.1.2/token",
      "https://[::1]/token",
      "https://8.8.8.8/token",
      "https://api.example.invalid/token",
      "https://user:pass@api.example.com/token",
      "https://api.example.com/token#secret",
    ]) expect(isSafeYonyouEndpoint(url), url).toBe(false);
    expect(isSafeYonyouEndpoint("https://openapi.example.com/token")).toBe(true);
  });

  it("拒绝主/别名凭据冲突，不静默选择其中一个", () => {
    const env = {
      ...completeEnv(),
      YY_CLIENT_ID: "different",
      YY_CLIENT_SECRET: "different-secret",
    };
    expect(yonyouConfigFromEnv(env)).toBeNull();
    expect(yonyouMissingEnv(env)).toEqual(expect.arrayContaining([
      "YY_APP_KEY",
      "YY_CLIENT_ID",
      "YY_APP_SECRET",
      "YY_CLIENT_SECRET",
    ]));
  });

  it("解析受控产品与去重后的 API 契约清单", () => {
    expect(parseYonyouProductProfile(" YONBIP ")).toBe("yonbip");
    expect(parseYonyouProductProfile("unknown")).toBeNull();
    expect(parseYonyouApprovedApiContracts("a@v1, b@v2, a@v1")).toEqual(["a@v1", "b@v2"]);
    expect(parseYonyouApprovedApiContracts(" , ")).toBeNull();
  });

  it("审计只输出存在性和数量，不泄露密钥、租户、组织、URL 或接口名", () => {
    const env = completeEnv();
    const report = auditYonyouReadiness(env);
    expect(report).toMatchObject({
      status: "contract_ready",
      implementation: "contract_only",
      safeToCall: false,
      credentialsPresent: { appKey: true, appSecret: true },
      productProfile: "yonsuite",
      approvedApiContractCount: 2,
      missingEnv: [],
    });
    const serialized = JSON.stringify(report);
    for (const secretValue of [
      env.YY_APP_KEY,
      env.YY_APP_SECRET,
      env.YY_TENANT_ID,
      env.YY_ORG_ID,
      env.YY_BASE_URL,
      env.YY_TOKEN_URL,
      "supplier.read@v1",
    ]) expect(serialized).not.toContain(secretValue!);
  });
});
