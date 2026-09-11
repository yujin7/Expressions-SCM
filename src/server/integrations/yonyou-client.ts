/**
 * 用友 YonBIP OpenAPI 运行时客户端。
 *
 * 在此之前 `yonyou.ts` 只有配置与安全校验（注释里写着 "Future token clients will…"），
 * 连接器就绪度因此报 `implementation=contract_only`：即便控制台把 API 授权全开，
 * 也没有任何代码会去取数。本文件补上这一层。
 *
 * 三条纪律：
 *  1. **契约白名单**：只能按名字调用 `YY_APPROVED_API_CONTRACTS` 里选中的只读契约，
 *     不接受任意 path——环境变量里写错一个字不能扩大凭据的数据范围。
 *  2. **出站边界**：每次请求前复用 `isSafeYonyouEndpoint` + `assertYonyouDnsResolutionSafe`，
 *     AppSecret 只发往通过白名单与公网 DNS 校验的地址。
 *  3. **只读**：契约表里全是查询类接口；本客户端不提供任何写方法。
 *
 * 网关口径（2026-08-03 实测）：正确网关是 `https://c4.yonyoucloud.com/iuap-api-gateway`，
 * 业务调用把 access_token 放 **query**（放 header 会得到 310001 access_token 不能为空）。
 */
import { createHmac } from "node:crypto";
import { fetchJson, type FetchJsonOptions } from "./http";
import {
  assertYonyouDnsResolutionSafe,
  type DnsLookup,
  isSafeYonyouEndpoint,
  type YonyouOpenApiConfig,
} from "./yonyou";
import { yonyouReadContractByName, type YonyouReadContractName } from "./yonyou-contracts";

/** 网关业务错误。code 是用友的字符串错误码，保留原文便于运维按码检索。 */
export class YonyouApiError extends Error {
  readonly code: string;
  readonly contract: string;

  constructor(code: string, contract: string) {
    const safeCode = /^\d{1,10}$/.test(code) ? code : "unknown";
    const safeContract = contract === "取 access_token" || yonyouReadContractByName(contract) ? contract : "未识别契约";
    const guidance = ["310005", "310037"].includes(safeCode) ? "请核对控制台应用与接口授权"
      : "调用失败，请按错误码核对配置与服务状态";
    super(`用友 ${safeContract} 返回 ${safeCode}：${guidance}`);
    this.name = "YonyouApiError";
    this.code = safeCode;
    this.contract = safeContract;
  }

  /** 授权类错误不该重试——重试只会刷日志，且掩盖"没在控制台授权"这个真实原因。 */
  get retryable(): boolean {
    return !["310005", "310037", "310001", "310405"].includes(this.code);
  }

  /** 控制台未逐条勾选该 API。运维看到这个应去开放平台授权，而不是查代码。 */
  get needsConsoleGrant(): boolean {
    return this.code === "310037" || this.code === "310005";
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`用友响应 ${label} 不是对象`);
  }
  return value as Record<string, unknown>;
}

export class YonyouClient {
  private readonly config: YonyouOpenApiConfig;
  private readonly transport: FetchJsonOptions;
  private readonly now: () => Date;
  private cachedToken: CachedToken | null = null;

  private readonly dnsLookup?: DnsLookup;

  constructor(
    config: YonyouOpenApiConfig,
    /**
     * `dnsLookup` 只用于测试注入。生产不传 → 走 node:dns 真实解析，
     * 出站防重绑保护不变。此前没有这个注入点，单测每次都真去解析
     * c4.yonyoucloud.com——挂 VPN 或断网时每条用例卡满 30 秒超时，
     * 合并门因此变得又慢又不可信。
     */
    options: FetchJsonOptions & { now?: () => Date; dnsLookup?: DnsLookup } = {},
  ) {
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") };
    this.transport = options;
    this.now = options.now ?? (() => new Date());
    this.dnsLookup = options.dnsLookup;
  }

  /** HMAC-SHA256(appSecret) over key-sorted `key+value` concatenation, base64. */
  private sign(params: Record<string, string>): string {
    return createHmac("sha256", this.config.appSecret)
      .update(Object.keys(params).sort().map((k) => `${k}${params[k]}`).join(""), "utf8")
      .digest("base64");
  }

  /** 发送前的出站校验：白名单 + 公网 DNS。两者任一不过就不发凭据。 */
  private async assertEndpointSafe(url: string): Promise<void> {
    if (!isSafeYonyouEndpoint(url, this.config.allowedHosts)) {
      throw new Error("用友端点未通过白名单校验，拒绝发送凭据；请核对 token/base URL 配置");
    }
    await assertYonyouDnsResolutionSafe(url, this.dnsLookup);
  }

  /**
   * 取 access_token，带内存缓存。用友返回 expire（秒），提前 120 秒过期以避开边界。
   */
  async getAccessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cachedToken && this.cachedToken.expiresAt > nowMs) return this.cachedToken.token;

    await this.assertEndpointSafe(this.config.tokenUrl);
    const timestamp = String(nowMs);
    const signature = this.sign({ appKey: this.config.appKey, timestamp });
    const url = `${this.config.tokenUrl}?appKey=${encodeURIComponent(this.config.appKey)}`
      + `&timestamp=${timestamp}&signature=${encodeURIComponent(signature)}`;

    const payload = await fetchJson("用友", url, { method: "GET" }, this.transport);
    const envelope = asObject(payload, "token envelope");
    const code = String(envelope.code ?? "");
    if (code !== "00000") {
      throw new YonyouApiError(code, "取 access_token");
    }
    const data = asObject(envelope.data, "token data");
    const token = typeof data.access_token === "string" ? data.access_token : "";
    if (!token) throw new Error("用友 token 响应缺少 access_token");

    const expireSeconds = Number(data.expire);
    const ttlMs = Number.isFinite(expireSeconds) && expireSeconds > 120
      ? (expireSeconds - 120) * 1000
      : 60_000;
    this.cachedToken = { token, expiresAt: nowMs + ttlMs };
    return token;
  }

  /**
   * 按**契约名**调用只读接口。名字必须同时满足：
   *  - 在 `yonyou-contracts.ts` 的契约表里（代码评审过的路径）；
   *  - 在本环境 `YY_APPROVED_API_CONTRACTS` 选中的子集里（企业批准过的范围）。
   */
  async callContract(
    name: YonyouReadContractName,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const contract = yonyouReadContractByName(name);
    if (!contract) throw new Error(`未知的用友契约：${name}`);
    if (!this.config.approvedApiContracts.includes(name)) {
      throw new Error(`契约「${name}」不在 YY_APPROVED_API_CONTRACTS 批准范围内，拒绝调用`);
    }

    const token = await this.getAccessToken();
    const url = `${this.config.baseUrl}${contract.path}`;
    await this.assertEndpointSafe(url);

    const payload = await fetchJson(
      "用友",
      `${url}?access_token=${encodeURIComponent(token)}`,
      {
        method: contract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.transport,
    );
    const envelope = asObject(payload, "envelope");
    const code = String(envelope.code ?? "");
    // 无状态码的兼容响应必须有对象 data；不能把空/错误信封回退成业务数据。
    if (code && code !== "00000") {
      throw new YonyouApiError(code, name);
    }
    if (envelope.success === false) {
      throw new Error("用友响应明确标记失败，请核对接口契约与服务状态");
    }
    return asObject(code === "00000" ? envelope.data ?? envelope : envelope.data, "data");
  }

  /**
   * 逐条探测已批准契约的授权状态。这是「控制台勾选后立刻可验证」的闭环入口，
   * 也是 /admin/health 与就绪度体检要用的事实来源——不靠人工回忆授权到哪一步。
   */
  async probeApprovedContracts(): Promise<{
    name: string;
    granted: boolean;
    code: string | null;
    needsConsoleGrant: boolean;
  }[]> {
    const results: {
      name: string;
      granted: boolean;
      code: string | null;
      needsConsoleGrant: boolean;
    }[] = [];
    for (const name of this.config.approvedApiContracts) {
      try {
        await this.callContract(name as YonyouReadContractName, { pageIndex: 1, pageSize: 1 });
        results.push({ name, granted: true, code: null, needsConsoleGrant: false });
      } catch (error) {
        if (error instanceof YonyouApiError) {
          results.push({
            name,
            granted: false,
            code: error.code,
            needsConsoleGrant: error.needsConsoleGrant,
          });
        } else {
          results.push({ name, granted: false, code: null, needsConsoleGrant: false });
        }
      }
    }
    return results;
  }
}
