import { fetchJson, type FetchJsonOptions } from "./http";

const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/";
const MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const TOKEN_SKEW_MS = 60_000;

export interface FeishuAppConfig {
  appId: string;
  appSecret: string;
  chatId: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export function feishuAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuAppConfig | null {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  const chatId = env.FEISHU_CHAT_ID?.trim();
  if (!appId || !appSecret || !chatId) return null;
  return { appId, appSecret, chatId };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`飞书响应 ${label} 结构非法`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result === "" ? null : result;
}

export class FeishuAppClient {
  private readonly config: FeishuAppConfig;
  private readonly transport: FetchJsonOptions;
  private readonly now: () => number;
  private token: CachedToken | null = null;

  constructor(
    config: FeishuAppConfig,
    options: FetchJsonOptions & { now?: () => number } = {},
  ) {
    this.config = config;
    this.transport = options;
    this.now = options.now ?? Date.now;
  }

  async tenantAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_SKEW_MS > this.now()) return this.token.value;
    const payload = object(await fetchJson(
      "飞书鉴权",
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
      this.transport,
    ), "token");
    const code = Number(payload.code);
    if (code !== 0) throw new Error(`飞书鉴权 ${Number.isFinite(code) ? code : "unknown"}: ${text(payload.msg) ?? "未知错误"}`);
    const token = text(payload.tenant_access_token);
    const expireSeconds = Number(payload.expire);
    if (!token || !Number.isFinite(expireSeconds) || expireSeconds <= 0) {
      throw new Error("飞书鉴权响应缺少 token/expire");
    }
    this.token = { value: token, expiresAt: this.now() + expireSeconds * 1000 };
    return token;
  }

  async sendText(input: {
    title: string;
    body: string;
    href?: string | null;
    uuid: string;
  }): Promise<{ messageId: string | null }> {
    const token = await this.tenantAccessToken();
    const content = `【供应链】${input.title}\n${input.body}${input.href ? `\n${input.href}` : ""}`;
    const payload = object(await fetchJson(
      "飞书消息",
      `${MESSAGE_URL}?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: this.config.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: content }),
          uuid: input.uuid.slice(0, 50),
        }),
      },
      this.transport,
    ), "message");
    const code = Number(payload.code);
    if (code !== 0) throw new Error(`飞书消息 ${Number.isFinite(code) ? code : "unknown"}: ${text(payload.msg) ?? "未知错误"}`);
    const data = object(payload.data ?? {}, "message.data");
    return { messageId: text(data.message_id) };
  }
}
