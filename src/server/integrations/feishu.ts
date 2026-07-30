import { fetchJson, type FetchJsonOptions } from "./http";

const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/";
const MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const CHATS_URL = "https://open.feishu.cn/open-apis/im/v1/chats";
const WEBHOOK_HOST = "open.feishu.cn";
const WEBHOOK_PATH = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/;
const TOKEN_SKEW_MS = 60_000;
const MAX_CHAT_PAGES = 100;

export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
}

export interface FeishuAppConfig extends FeishuAppCredentials {
  chatId: string;
}

export function feishuWebhookUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.FEISHU_WEBHOOK_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:"
      || url.hostname.toLowerCase() !== WEBHOOK_HOST
      || (url.port !== "" && url.port !== "443")
      || url.username
      || url.password
      || url.search
      || url.hash
      || !WEBHOOK_PATH.test(url.pathname)
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export function feishuAppCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FeishuAppCredentials | null {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export function feishuAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuAppConfig | null {
  const credentials = feishuAppCredentialsFromEnv(env);
  const chatId = env.FEISHU_CHAT_ID?.trim();
  if (!credentials || !chatId) return null;
  return { ...credentials, chatId };
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
  private readonly config: FeishuAppCredentials & { chatId?: string };
  private readonly transport: FetchJsonOptions;
  private readonly now: () => number;
  private token: CachedToken | null = null;

  constructor(
    config: FeishuAppCredentials & { chatId?: string },
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
    if (!this.config.chatId) throw new Error("飞书应用未配置目标 chat_id");
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

  async listAccessibleChats(): Promise<Array<{ chatId: string; name: string | null }>> {
    const token = await this.tenantAccessToken();
    const result: Array<{ chatId: string; name: string | null }> = [];
    let pageToken: string | null = null;
    for (let page = 1; page <= MAX_CHAT_PAGES; page++) {
      const query = new URLSearchParams({ page_size: "100" });
      if (pageToken) query.set("page_token", pageToken);
      const payload = object(await fetchJson(
        "飞书群目录",
        `${CHATS_URL}?${query.toString()}`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } },
        this.transport,
      ), "chats");
      const code = Number(payload.code);
      if (code !== 0) {
        throw new Error(`飞书群目录 ${Number.isFinite(code) ? code : "unknown"}: ${text(payload.msg) ?? "未知错误"}`);
      }
      const data = object(payload.data ?? {}, "chats.data");
      const items = Array.isArray(data.items) ? data.items : [];
      for (let index = 0; index < items.length; index++) {
        const item = object(items[index], `chats.data.items[${index}]`);
        const chatId = text(item.chat_id);
        if (!chatId) throw new Error(`飞书群目录 items[${index}] 缺少 chat_id`);
        result.push({ chatId, name: text(item.name) });
      }
      if (data.has_more !== true) {
        return [...new Map(result.map((chat) => [chat.chatId, chat])).values()]
          .sort((left, right) =>
            `${left.name ?? ""}\0${left.chatId}`.localeCompare(
              `${right.name ?? ""}\0${right.chatId}`,
              "zh-CN",
            ));
      }
      const next = text(data.page_token);
      if (!next || next === pageToken) throw new Error("飞书群目录游标未前进");
      pageToken = next;
    }
    throw new Error(`飞书群目录超过安全页上限 ${MAX_CHAT_PAGES}`);
  }
}
