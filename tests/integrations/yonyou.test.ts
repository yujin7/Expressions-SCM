import { describe, expect, it } from "vitest";
import {
  assertYonyouDnsResolutionSafe,
  isSafeYonyouEndpoint,
  isPublicYonyouAddress,
  parseYonyouAllowedHosts,
  parseYonyouApprovedApiContracts,
  parseYonyouProductProfile,
  yonyouConfigFromEnv,
  yonyouEvidenceRefHasLiveBinding,
  yonyouLiveEvidenceBinding,
  yonyouMissingEnv,
  yonyouSyncEnabled,
} from "@/server/integrations/yonyou";
import { auditYonyouReadiness } from "@/jobs/audit-yonyou";
import {
  YONYOU_READ_CONTRACTS,
  areKnownYonyouReadContracts,
  yonyouReadContractByName,
} from "@/server/integrations/yonyou-contracts";

function completeEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    YY_APP_KEY: "app-key",
    YY_APP_SECRET: "app-secret",
    YY_TENANT_ID: "tenant",
    YY_ORG_ID: "org",
    YY_PRODUCT_PROFILE: "yonbip",
    YY_APPROVED_API_CONTRACTS: "供应商档案列表查询, 存货成本查询,供应商档案列表查询",
    YY_ALLOWED_HOSTS: "c4.yonyoucloud.com",
    YY_BASE_URL: "https://c4.yonyoucloud.com/iuap-api-gateway",
    YY_TOKEN_URL: "https://c4.yonyoucloud.com/iuap-api-auth/open-auth/token",
  };
}

describe("用友 OpenAPI 前置契约", () => {
  it("只有产品、获批接口和公开 HTTPS 端点完整时才形成配置", () => {
    const env = completeEnv();
    expect(yonyouMissingEnv(env)).toEqual([]);
    expect(yonyouConfigFromEnv(env)).toMatchObject({
      productProfile: "yonbip",
      approvedApiContracts: ["供应商档案列表查询", "存货成本查询"],
      allowedHosts: ["c4.yonyoucloud.com"],
    });
    delete env.YY_PRODUCT_PROFILE;
    expect(yonyouConfigFromEnv(env)).toBeNull();
    expect(yonyouMissingEnv(env)).toContain("YY_PRODUCT_PROFILE");
  });

  it("拒绝可窃取机器凭据的非公开、不安全或带凭据端点", () => {
    const allowed = ["api.yonyoucloud.com"];
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
      "https://attacker.example.com/token",
    ]) expect(isSafeYonyouEndpoint(url, allowed), url).toBe(false);
    expect(isSafeYonyouEndpoint("https://api.yonyoucloud.com/token", allowed)).toBe(true);
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
    expect(parseYonyouApprovedApiContracts(
      "供应商档案列表查询, 存货成本查询,供应商档案列表查询",
    )).toEqual(["供应商档案列表查询", "存货成本查询"]);
    expect(parseYonyouApprovedApiContracts("unknown.read@v1")).toBeNull();
    expect(parseYonyouApprovedApiContracts(" , ")).toBeNull();
    expect(parseYonyouAllowedHosts("API.YONYOUCLOUD.COM, api.yonyoucloud.com")).toEqual([
      "api.yonyoucloud.com",
    ]);
    expect(parseYonyouAllowedHosts("*.yonyoucloud.com")).toBeNull();
    expect(parseYonyouAllowedHosts("127.0.0.1")).toBeNull();
    expect(yonyouSyncEnabled({ NODE_ENV: "test", YY_SYNC_ENABLED: " YES " })).toBe(true);
    expect(yonyouSyncEnabled({ NODE_ENV: "test", YY_SYNC_ENABLED: "false" })).toBe(false);
  });

  it("UAT 绑定覆盖应用、租户/组织、产品、契约和端点且不暴露原值", () => {
    const env = completeEnv();
    const binding = yonyouLiveEvidenceBinding(env);
    expect(binding).toMatch(/^YY1_[A-F0-9]{24}$/);
    expect(yonyouEvidenceRefHasLiveBinding(`UAT-20260803-${binding}`, env)).toBe(true);
    expect(yonyouEvidenceRefHasLiveBinding(`UAT-${binding}-EXTRA`, env)).toBe(false);
    expect(binding).not.toContain(env.YY_APP_KEY!);
    expect(binding).not.toContain(env.YY_TENANT_ID!);
    expect(yonyouLiveEvidenceBinding({ ...env, YY_ORG_ID: "other-org" })).not.toBe(binding);
    expect(yonyouLiveEvidenceBinding({
      ...env,
      YY_APPROVED_API_CONTRACTS: "供应商档案列表查询,凭证列表查询",
    })).not.toBe(binding);
    expect(yonyouLiveEvidenceBinding({ ...env, YY_APP_SECRET: "rotated" })).toBe(binding);
  });

  it("连接前 DNS 检查拒绝私网、回环、保留和 IPv4-mapped IPv6", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) expect(isPublicYonyouAddress(address), address).toBe(false);
    expect(isPublicYonyouAddress("8.8.8.8")).toBe(true);
    expect(isPublicYonyouAddress("2606:4700:4700::1111")).toBe(true);
    await expect(assertYonyouDnsResolutionSafe(
      "https://api.yonyoucloud.com/token",
      async () => [{ address: "169.254.169.254", family: 4 }],
    )).rejects.toThrow("非公网地址");
    await expect(assertYonyouDnsResolutionSafe(
      "https://api.yonyoucloud.com/token",
      async () => [{ address: "8.8.8.8", family: 4 }],
    )).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("空白主凭据不会覆盖有效别名凭据", () => {
    const env = {
      ...completeEnv(),
      YY_APP_KEY: "   ",
      YY_APP_SECRET: "  ",
      YY_CLIENT_ID: "alias-key",
      YY_CLIENT_SECRET: "alias-secret",
    };
    expect(yonyouConfigFromEnv(env)).toMatchObject({
      appKey: "alias-key",
      appSecret: "alias-secret",
    });
  });

  it("审计只输出存在性和数量，不泄露密钥、租户、组织、URL 或接口名", () => {
    const env = completeEnv();
    const report = auditYonyouReadiness(env);
    expect(report).toMatchObject({
      status: "contract_ready",
      implementation: "contract_only",
      safeToCall: false,
      credentialsPresent: { appKey: true, appSecret: true },
      productProfile: "yonbip",
      approvedApiContractCount: 2,
      syncEnabled: false,
      expectedLiveVerificationBinding: expect.stringMatching(/^YY1_/),
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
      "供应商档案列表查询",
    ]) expect(serialized).not.toContain(secretValue!);
  });

  it("只接受在目标 YonBIP 租户官方目录核实过的八条只读契约", () => {
    expect(YONYOU_READ_CONTRACTS).toHaveLength(8);
    expect(new Set(YONYOU_READ_CONTRACTS.map((contract) => contract.name)).size).toBe(8);
    expect(new Set(YONYOU_READ_CONTRACTS.map((contract) => contract.path)).size).toBe(8);
    expect(areKnownYonyouReadContracts(YONYOU_READ_CONTRACTS.map((contract) => contract.name))).toBe(true);
    expect(areKnownYonyouReadContracts(["凭证保存"])).toBe(false);
    expect(yonyouReadContractByName("现存量查询 V2")).toMatchObject({
      method: "POST",
      path: "/yonbip/scm/stock/QueryCurrentStocksByCondition",
      domain: "inventory",
    });
    expect(YONYOU_READ_CONTRACTS.every((contract) => !contract.path.includes("save"))).toBe(true);
  });
});
