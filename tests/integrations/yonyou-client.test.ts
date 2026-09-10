/**
 * 用友运行时客户端测试。
 *
 * 背景：`yonyou.ts` 长期只有配置与安全校验，连接器就绪度报 `implementation=contract_only`
 * ——控制台就算把 API 全授权，也没有任何代码会去取数。`yonyou-client.ts` 补上这一层，
 * 本测试证明它在**授权到位之前**就已经是对的（用假 transport 跑完整路径）。
 *
 * 重点钉住三条纪律：契约白名单、出站边界、只读；以及 310037 不重试（授权类错误重试
 * 只会刷日志并掩盖"没在控制台授权"这个真实原因）。
 */
import { describe, expect, it, vi } from "vitest";
import { YonyouApiError, YonyouClient } from "@/server/integrations/yonyou-client";
import type { YonyouOpenApiConfig } from "@/server/integrations/yonyou";

const CONFIG: YonyouOpenApiConfig = {
  appKey: "test-app-key",
  appSecret: "test-app-secret",
  tenantId: "t1",
  orgId: "o1",
  productProfile: "c4",
  approvedApiContracts: ["分页查询当前租户组织架构", "存货成本查询"],
  allowedHosts: ["c4.yonyoucloud.com"],
  baseUrl: "https://c4.yonyoucloud.com/iuap-api-gateway",
  tokenUrl: "https://c4.yonyoucloud.com/iuap-api-gateway/open-auth/selfAppAuth/getAccessToken",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN_OK = { code: "00000", message: "成功！", data: { expire: 7200, access_token: "tok-abc" } };

/**
 * 出站防重绑守卫会真的做 DNS 解析。此前这里没有注入点，单测每次都去解析
 * c4.yonyoucloud.com——挂 VPN 或断网时每条用例卡满 30 秒超时（实测 5/9 失败、
 * 单文件跑 150 秒）。注入一个恒定公网地址（不能用 203.0.113.x 这类文档保留段——守卫会正确地判它非公网）。
 */
const STUB_DNS = async () => [{ address: "121.199.0.1", family: 4 }] as const;

function makeClient(fetchImpl: typeof fetch, now = () => new Date(1_700_000_000_000)) {
  return new YonyouClient(CONFIG, { fetchImpl, retries: 0, now, dnsLookup: STUB_DNS });
}

describe("用友运行时客户端", () => {
  it("取 token 成功，并在有效期内复用缓存（不重复把 AppSecret 发出去）", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getAccessToken")) return jsonResponse(TOKEN_OK);
      return jsonResponse({ code: "00000", data: { rows: [] } });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.callContract("分页查询当前租户组织架构", {});
    await client.callContract("分页查询当前租户组织架构", {});

    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("getAccessToken"));
    expect(tokenCalls, "第二次调用应命中 token 缓存").toHaveLength(1);
  });

  it("拒绝调用不在 YY_APPROVED_API_CONTRACTS 批准范围内的契约", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(TOKEN_OK));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    // 「供应商档案列表查询」是合法契约，但本环境没批准它
    await expect(
      client.callContract("供应商档案列表查询", {}),
    ).rejects.toThrow(/不在 YY_APPROVED_API_CONTRACTS 批准范围内/);

    expect(fetchMock, "未批准的契约不应发出任何请求").not.toHaveBeenCalled();
  });

  it("baseUrl 不在 allowedHosts 白名单内时拒绝发送凭据", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(TOKEN_OK));
    const client = new YonyouClient(
      { ...CONFIG, allowedHosts: ["other.example.com"] },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    await expect(client.getAccessToken()).rejects.toThrow(/未通过白名单校验，拒绝发送凭据/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("310037 判为需控制台授权且不可重试（重试只会掩盖真实原因）", () => {
    const error = new YonyouApiError("310037", "存货成本查询");
    expect(error.needsConsoleGrant).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("310005 应用不存在同样判为需控制台处理（多为网关/集群不符）", () => {
    const error = new YonyouApiError("310005", "存货成本查询");
    expect(error.needsConsoleGrant).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("业务错误码抛 YonyouApiError 并保留原始 code", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("getAccessToken")) return jsonResponse(TOKEN_OK);
      return jsonResponse({
        code: "310037",
        message: "API未被授权：APPKEY[x]未获得要调用的API[/y]的授权",
      });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.callContract("存货成本查询", {})).rejects.toMatchObject({
      name: "YonyouApiError",
      code: "310037",
    });
  });

  it("逐条探测把「已授权 / 待控制台授权」如实分列——这是授权后立刻可验证的闭环", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("getAccessToken")) return jsonResponse(TOKEN_OK);
      // 组织架构已授权，存货成本仍未授权
      if (url.includes("/uspace/org/page_list")) {
        return jsonResponse({ code: "00000", data: { rows: [{ id: "org-1" }] } });
      }
      return jsonResponse({ code: "310037", message: "未获得授权" });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const results = await client.probeApprovedContracts();
    expect(results).toEqual([
      { name: "分页查询当前租户组织架构", granted: true, code: null, needsConsoleGrant: false },
      { name: "存货成本查询", granted: false, code: "310037", needsConsoleGrant: true },
    ]);
  });

  it("token 响应非 00000 时抛错，不把空 token 往下传", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: "310001", message: "签名错误" }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.getAccessToken()).rejects.toThrow(/310001/);
  });

  it("access_token 走 query 而非 header（放 header 实测得 310001）", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("getAccessToken")) return jsonResponse(TOKEN_OK);
      const headers = new Headers(init?.headers);
      expect(headers.get("access_token"), "不应把 token 放 header").toBeNull();
      return jsonResponse({ code: "00000", data: {} });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await client.callContract("存货成本查询", {});

    const bizCall = seen.find((u) => u.includes("queryBalance"));
    expect(bizCall).toContain("access_token=tok-abc");
  });

  it.each([
    {},
    { message: "RAW-SECRET-RESPONSE" },
    { data: null },
    { data: [] },
    { data: "RAW-SECRET-RESPONSE" },
    { code: "", message: "RAW-SECRET-RESPONSE" },
    { success: false, data: { rows: [] } },
    { code: "00000", success: false, data: {} },
  ])("不把无成功证据或明确失败的响应当成已授权：%j", async (body) => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      jsonResponse(String(input).includes("getAccessToken") ? TOKEN_OK : body));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.callContract("分页查询当前租户组织架构")).rejects.toThrow();
    const result = await client.probeApprovedContracts();
    expect(result.every((row) => !row.granted)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("RAW-SECRET-RESPONSE");
  });

  it.each([
    { code: "00000", data: { rows: [] } },
    { data: { rows: [] } },
    { code: "", data: { rows: [] } },
  ])("保留已支持的明确成功/无状态码但有data信封：%j", async (body) => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      jsonResponse(String(input).includes("getAccessToken") ? TOKEN_OK : body));
    await expect(makeClient(fetchMock as unknown as typeof fetch).callContract("分页查询当前租户组织架构"))
      .resolves.toEqual({ rows: [] });
  });

  it("保留明确成功码的无data直包，但不推断其中记录语义", async () => {
    const body = { code: "00000", recordList: [] };
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      jsonResponse(String(input).includes("getAccessToken") ? TOKEN_OK : body));
    await expect(makeClient(fetchMock as unknown as typeof fetch).callContract("分页查询当前租户组织架构"))
      .resolves.toEqual(body);
  });
});
