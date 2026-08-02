import { createHash } from "node:crypto";
import { fetchJson, type FetchJsonOptions } from "./http";

const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/";
const MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const CHATS_URL = "https://open.feishu.cn/open-apis/im/v1/chats";
const SELF_APPLICATION_URL =
  "https://open.feishu.cn/open-apis/application/v6/applications/me?lang=zh_cn";
const WEBHOOK_HOST = "open.feishu.cn";
const WEBHOOK_PATH = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/;
const TOKEN_SKEW_MS = 60_000;
const MAX_CHAT_PAGES = 100;
const CHAT_LIST_SCOPE = "im:chat:readonly";
const SEND_AS_BOT_SCOPE = "im:message:send_as_bot";
const SELF_APPLICATION_SCOPE = "application:application:self_manage";
const NOTIFICATION_SCOPE_ALLOWLIST = new Set([
  CHAT_LIST_SCOPE,
  SEND_AS_BOT_SCOPE,
  SELF_APPLICATION_SCOPE,
]);
// Local SCM policy tripwire, not a Feishu platform limit. Any non-allowlisted scope needs review;
// a double-digit excess is treated as extreme rather than merely advisory.
const EXTREME_SCOPE_TOTAL = 25;
const EXTREME_OUTSIDE_ALLOWLIST = 10;
const TARGET_BINDING_PREFIX = "FST1_";
const PERMISSION_SET_FINGERPRINT_PREFIX = "FSS1_";
const PERMISSION_REVIEW_BINDING_PREFIX = "FSP2_";

export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
}

export interface FeishuAppConfig extends FeishuAppCredentials {
  chatId: string;
}

export type FeishuEvidenceState = "present" | "absent" | "unknown";
export type FeishuEnabledState = "enabled" | "not_enabled" | "unknown";
export type FeishuBotDefaultState =
  | "bot_default_both"
  | "bot_default_partial"
  | "not_bot_default"
  | "unknown";
export type FeishuScopeDeclaration = "declared" | "not_declared" | "unknown";
export type FeishuLeastPrivilegeState =
  | "no_excess_detected"
  | "review_required"
  | "extreme_over_privilege"
  | "unknown";

export interface FeishuSelfApplicationInspection {
  enabled: FeishuEnabledState;
  onlineVersion: FeishuEvidenceState;
  botDefault: FeishuBotDefaultState;
  scopes: {
    inventory: "parsed" | "ambiguous" | "unavailable";
    /** One-way digest of the normalized scope names and levels; raw permission names never escape. */
    fingerprint: string | null;
    total: number | null;
    elevated: number | null;
    chatList: FeishuScopeDeclaration;
    sendAsBot: FeishuScopeDeclaration;
    outsideNotificationAllowlist: number | null;
    leastPrivilege: FeishuLeastPrivilegeState;
  };
}

/** Non-secret, one-way marker binding UAT evidence to one app and one exact target chat. */
export function feishuTargetEvidenceBinding(appId: string, chatId: string): string {
  const digest = createHash("sha256")
    .update(`feishu-app-target-v1\0${appId}\0${chatId}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `${TARGET_BINDING_PREFIX}${digest}`;
}

export function feishuEvidenceRefHasTargetBinding(
  reference: string | null,
  appId: string,
  chatId: string,
): boolean {
  if (!reference) return false;
  const binding = feishuTargetEvidenceBinding(appId, chatId);
  return reference === binding || reference.endsWith(`-${binding}`);
}

export interface FeishuPermissionDescriptor {
  scope: string;
  level: number;
}

/** Stable, non-secret digest of a permission set; ordering and duplicate rows do not affect it. */
export function feishuPermissionSetFingerprint(
  permissions: readonly FeishuPermissionDescriptor[],
): string {
  const normalized = [...new Map(permissions.map((permission) => {
    const scope = permission.scope.trim();
    const level = Number(permission.level);
    return [`${scope}\0${level}`, { scope, level }] as const;
  })).values()].sort((left, right) =>
    left.scope === right.scope
      ? left.level - right.level
      : left.scope < right.scope ? -1 : 1);
  const digest = createHash("sha256")
    .update(`feishu-permission-set-v1\0${JSON.stringify(normalized)}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `${PERMISSION_SET_FINGERPRINT_PREFIX}${digest}`;
}

/** Non-secret marker binding a review to one app and the exact normalized permission set. */
export function feishuPermissionReviewEvidenceBinding(
  appId: string,
  permissionSetFingerprint: string,
): string {
  const digest = createHash("sha256")
    .update(`feishu-app-permission-review-v2\0${appId}\0${permissionSetFingerprint}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `${PERMISSION_REVIEW_BINDING_PREFIX}${digest}`;
}

export function feishuEvidenceRefHasPermissionReviewBinding(
  reference: string | null,
  appId: string,
  permissionSetFingerprint: string,
): boolean {
  if (!reference) return false;
  const binding = feishuPermissionReviewEvidenceBinding(appId, permissionSetFingerprint);
  return reference === binding || reference.endsWith(`-${binding}`);
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function declaredScope(
  names: readonly (string | null)[],
  scope: string,
): FeishuScopeDeclaration {
  if (names.includes(scope)) return "declared";
  return names.every((name) => name !== null) ? "not_declared" : "unknown";
}

function inspectScopes(value: unknown): FeishuSelfApplicationInspection["scopes"] {
  if (!Array.isArray(value)) {
    return {
      inventory: "unavailable",
      fingerprint: null,
      total: null,
      elevated: null,
      chatList: "unknown",
      sendAsBot: "unknown",
      outsideNotificationAllowlist: null,
      leastPrivilege: "unknown",
    };
  }

  const items = value.map((item) => record(item));
  const names = items.map((item) =>
    typeof item?.scope === "string" && item.scope.trim() !== "" ? item.scope.trim() : null);
  const levels = items.map((item) =>
    typeof item?.level === "number" && Number.isFinite(item.level) ? item.level : null);
  const inventory = names.every((name) => name !== null) ? "parsed" as const : "ambiguous" as const;
  const elevated = levels.every((level) => level !== null)
    ? levels.filter((level) => (level ?? 0) >= 2).length
    : null;
  const outsideNotificationAllowlist = inventory === "parsed"
    ? names.filter((name) => !NOTIFICATION_SCOPE_ALLOWLIST.has(name as string)).length
    : null;
  const fingerprint = inventory === "parsed" && levels.every((level) => level !== null)
    ? feishuPermissionSetFingerprint(items.map((item, index) => ({
        scope: names[index] as string,
        level: levels[index] as number,
      })))
    : null;
  const leastPrivilege: FeishuLeastPrivilegeState = outsideNotificationAllowlist === null
    ? "unknown"
    : value.length >= EXTREME_SCOPE_TOTAL
      || outsideNotificationAllowlist >= EXTREME_OUTSIDE_ALLOWLIST
      ? "extreme_over_privilege"
      : outsideNotificationAllowlist > 0 || value.length > NOTIFICATION_SCOPE_ALLOWLIST.size
        ? "review_required"
        : "no_excess_detected";

  return {
    inventory,
    fingerprint,
    total: value.length,
    elevated,
    chatList: declaredScope(names, CHAT_LIST_SCOPE),
    sendAsBot: declaredScope(names, SEND_AS_BOT_SCOPE),
    outsideNotificationAllowlist,
    leastPrivilege,
  };
}

function inspectOnlineVersion(app: Record<string, unknown> | null): FeishuEvidenceState {
  if (!app || !("online_version_id" in app) || typeof app.online_version_id !== "string") {
    return "unknown";
  }
  return app.online_version_id.trim() === "" ? "absent" : "present";
}

function inspectEnabled(app: Record<string, unknown> | null): FeishuEnabledState {
  if (!app || typeof app.status !== "number" || !Number.isFinite(app.status)) return "unknown";
  return app.status === 1 ? "enabled" : "not_enabled";
}

function botDefaultEvidence(value: unknown): FeishuEvidenceState {
  if (typeof value !== "string") return "unknown";
  return value.trim().toLowerCase() === "bot" ? "present" : "absent";
}

function inspectBotDefault(app: Record<string, unknown> | null): FeishuBotDefaultState {
  if (!app) return "unknown";
  const mobile = botDefaultEvidence(app.mobile_default_ability);
  const pc = botDefaultEvidence(app.pc_default_ability);
  if (mobile === "present" && pc === "present") return "bot_default_both";
  if (mobile === "present" || pc === "present") return "bot_default_partial";
  if (mobile === "absent" && pc === "absent") return "not_bot_default";
  return "unknown";
}

function feishuBusinessError(label: string, code: number): Error {
  return new Error(`${label} ${Number.isFinite(code) ? code : "unknown"}: 调用失败`);
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
    if (code !== 0) throw feishuBusinessError("飞书鉴权", code);
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
    if (code !== 0) throw feishuBusinessError("飞书消息", code);
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
        throw feishuBusinessError("飞书群目录", code);
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

  /**
   * Read-only self inspection. Returns only bounded evidence states and aggregate counts: it never
   * returns the app identity, raw permission names, credentials, or tenant token.
   */
  async inspectSelfApplication(): Promise<FeishuSelfApplicationInspection> {
    const token = await this.tenantAccessToken();
    const payload = object(await fetchJson(
      "飞书应用信息",
      SELF_APPLICATION_URL,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      this.transport,
    ), "application");
    const code = Number(payload.code);
    if (code !== 0) throw feishuBusinessError("飞书应用信息", code);
    const data = record(payload.data);
    const app = record(data?.app);
    return {
      enabled: inspectEnabled(app),
      onlineVersion: inspectOnlineVersion(app),
      botDefault: inspectBotDefault(app),
      scopes: inspectScopes(app?.scopes),
    };
  }
}
