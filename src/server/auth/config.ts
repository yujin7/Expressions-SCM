import { CredentialsSignin, type DefaultSession, type NextAuthConfig } from "next-auth";
// 仅为使 "next-auth/jwt" 模块进入编译，供下方 declare module 扩展 JWT 类型
import type {} from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import type { OAuth2Config } from "next-auth/providers";
import type { NextRequest } from "next/server";
import { verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import type { Role } from "@/server/core/constants";
import { loadUserScopes } from "@/server/core/data-scope";
import { authCookieConfig } from "./cookies";
import { refreshSessionIdentity } from "./session-version";
import { AUTH_SESSION_MAX_AGE, withinSessionLifetime } from "./session-policy";

/* ---------- 类型扩展：session/jwt 携带 userId/roles/isApprover + D62 数据范围 ---------- */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      roles: Role[];
      isApprover: boolean;
      sessionVersion: number;
      /** D62：null = 不限 */
      channelScope: number[] | null;
      deptScope: string[] | null;
      /** 范围载荷对应的 session_version（范围变更即 bump → 旧 JWT 失效） */
      scopeVersion: number;
    } & DefaultSession["user"];
  }
  interface User {
    roles?: Role[];
    isApprover?: boolean;
    sessionVersion?: number;
    channelScope?: number[] | null;
    deptScope?: string[] | null;
    scopeVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: number;
    roles?: Role[];
    isApprover?: boolean;
    sessionVersion?: number;
    channelScope?: number[] | null;
    deptScope?: string[] | null;
    scopeVersion?: number;
  }
}

/* ---------- 登录错误码（前端 login-form 映射为中文提示） ---------- */

export type LoginErrorCode = "invalid" | "disabled" | "rate_limited";

class LoginError extends CredentialsSignin {
  constructor(code: LoginErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/* ---------- 登录限速（内存滑动窗口；单实例部署口径，多实例 1.1 移 Redis） ---------- */

const RATE_WINDOW_MS = 5 * 60 * 1000;
const IP_MAX_ATTEMPTS = 20; // 每 IP：全部登录尝试 20 次 / 5 分钟
const PRINCIPAL_SOURCE_MAX_FAILED = 10; // 每用户名+来源：失败尝试 10 次 / 5 分钟
const SWEEP_THRESHOLD = 5000; // 键数超阈值时全表清扫，防内存无界增长

function sweepStale(map: Map<string, number[]>, now: number): void {
  for (const [k, arr] of map) {
    const live = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length === 0) map.delete(k);
    else map.set(k, live);
  }
}

/** 导出仅为可测性（tests/redteam）；生产路径只经 authorize 使用 */
export const loginRateLimiter = {
  ipAttempts: new Map<string, number[]>(),
  failedByPrincipalSource: new Map<string, number[]>(),
  /** 记录一次 IP 尝试并检查窗口；超限返回 false（不再计入，窗口自然滑动） */
  touchIp(ip: string, now = Date.now()): boolean {
    if (this.ipAttempts.size > SWEEP_THRESHOLD) sweepStale(this.ipAttempts, now);
    const live = (this.ipAttempts.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length >= IP_MAX_ATTEMPTS) {
      this.ipAttempts.set(ip, live);
      return false;
    }
    live.push(now);
    this.ipAttempts.set(ip, live);
    return true;
  },
  /**
   * 同一来源对同一用户名的失败窗口是否已满（只查不记）。
   *
   * 绝不能只按用户名限速或写 users.locked_until：用户名可预测，公网攻击者只需连续提交
   * 错误口令，就能把合法用户从所有设备上锁死。来源维度把攻击影响限制在攻击者自己的桶。
   */
  principalSourceBlocked(username: string, source: string, now = Date.now()): boolean {
    const key = `${username.trim().toLowerCase()}\u0000${source}`;
    const live = (this.failedByPrincipalSource.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length === 0) this.failedByPrincipalSource.delete(key);
    else this.failedByPrincipalSource.set(key, live);
    return live.length >= PRINCIPAL_SOURCE_MAX_FAILED;
  },
  /** 记一次失败尝试（凭证类失败：用户不存在/密码错） */
  recordFailure(username: string, source: string, now = Date.now()): void {
    if (this.failedByPrincipalSource.size > SWEEP_THRESHOLD) sweepStale(this.failedByPrincipalSource, now);
    const key = `${username.trim().toLowerCase()}\u0000${source}`;
    const live = (this.failedByPrincipalSource.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    live.push(now);
    this.failedByPrincipalSource.set(key, live);
  },
  clearPrincipalSource(username: string, source: string): void {
    this.failedByPrincipalSource.delete(`${username.trim().toLowerCase()}\u0000${source}`);
  },
  reset(): void {
    this.ipAttempts.clear();
    this.failedByPrincipalSource.clear();
  },
};

/**
 * 取真实客户端 IP，作为每 IP 登录限速的键。
 *
 * 这里曾取 `x-forwarded-for` 的**首跳**，那是错的：XFF 左侧各跳全部由客户端自带，
 * 攻击者每次请求换一个伪造值就能让限速形同虚设。2026-08-07 上公网前的审计实测：
 * 固定 XFF 时第 21 次起被限（限速本身有效），而**轮换 XFF 时 40/40 全部穿透**。
 * 叠加「连续 5 次失败锁账号 15 分钟」+ 种子用户名可预测，等于任何人都能远程
 * 把全公司账号（含 admin）持续锁死。
 *
 * 改为按可信度降序取：
 *   1. `cf-connecting-ip` —— 走 Cloudflare 隧道时由 Cloudflare 写入，且会**覆盖**
 *      客户端自带的同名头，因此穿过隧道的请求伪造不了；
 *   2. XFF 的**最右**一跳 —— 只作反向代理场景的尽力来源键；直连请求可自行伪造，
 *      因此绝不把它当鉴权证据或用来触发全局账号状态；
 *   3. 取不到则返回 null（与原行为一致：直连时跳过每 IP 限速）。
 *
 * 注意其固有边界：任何能**绕过隧道直连** 3100 端口的人（即同一局域网内）仍可伪造
 * 这两个头。这层只限制攻击成本，不承担鉴权，也绝不写全局锁；鉴权始终在口令校验与会话层。
 */
/* 导出仅为可测性（tests/redteam/client-ip-trust.redteam.test.ts）；生产路径只经 authorize 使用 */
export function clientIpOf(request: Request | undefined): string | null {
  const h = request?.headers;
  if (!h || typeof h.get !== "function") return null;

  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const xff = h.get("x-forwarded-for");
  if (!xff) return null;
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

/* ---------- 飞书 OAuth（仅当 FEISHU_APP_ID/SECRET 配置时启用） ---------- */

// 2026-07-26 已按现行飞书 OAuth 契约复核：
// - accounts.feishu.cn/authen/v1/authorize（标准 client_id，由 Auth.js 注入）
// - open.feishu.cn/authen/v2/oauth/token（顶层 access_token）
// - open.feishu.cn/authen/v1/user_info（{ code, msg, data: { union_id, name, avatar_url } }）
// profile 仍兼容 data 嵌套与顶层两种形状，避免 SDK 包装差异破坏登录。
type FeishuProfile = Record<string, unknown> & { data?: Record<string, unknown> };

export const FEISHU_OAUTH_ENDPOINTS = {
  authorization: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  token: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
  userinfo: "https://open.feishu.cn/open-apis/authen/v1/user_info",
} as const;

/** 导出仅为契约测试；生产路径由 Auth.js provider.profile 调用。 */
export function mapFeishuProfile(raw: FeishuProfile): {
  id: string;
  name: string;
  image: string | null;
} {
  const d = (raw && typeof raw === "object" && raw.data && typeof raw.data === "object"
    ? raw.data
    : raw) as Record<string, unknown>;
  return {
    // id = feishu union_id：signIn/jwt 回调据此查 users.feishuUnionId
    id: typeof d.union_id === "string" ? d.union_id : "",
    name: typeof d.name === "string" ? d.name : "飞书用户",
    image: typeof d.avatar_url === "string" ? d.avatar_url : null,
  };
}

function feishuProvider(appId: string, appSecret: string): OAuth2Config<FeishuProfile> {
  return {
    id: "feishu",
    name: "飞书",
    type: "oauth",
    clientId: appId,
    clientSecret: appSecret,
    authorization: {
      url: FEISHU_OAUTH_ENDPOINTS.authorization,
    },
    token: FEISHU_OAUTH_ENDPOINTS.token,
    userinfo: FEISHU_OAUTH_ENDPOINTS.userinfo,
    checks: ["state"],
    client: { token_endpoint_auth_method: "client_secret_post" },
    profile: mapFeishuProfile,
  };
}

/* ---------- 本地账号（argon2id + 来源隔离限速） ---------- */

const localProvider = Credentials({
  id: "local",
  name: "本地账号",
  credentials: {
    username: { label: "用户名" },
    password: { label: "密码", type: "password" },
  },
  async authorize(credentials, request) {
    // IP 滑动窗口（全部尝试计数）。直连没有可信 IP 时使用 direct 桶，仍不跳过限速。
    const ip = clientIpOf(request);
    const source = ip ?? "direct";
    if (!loginRateLimiter.touchIp(source)) {
      throw new LoginError("rate_limited", "尝试过于频繁，请稍后再试");
    }

    const username = typeof credentials?.username === "string" ? credentials.username.trim() : "";
    const password = typeof credentials?.password === "string" ? credentials.password : "";
    if (!username || !password) throw new LoginError("invalid");

    // 失败桶同时含用户名与来源，防止公开接口被用来全局锁死一个可预测账号。
    if (loginRateLimiter.principalSourceBlocked(username, source)) {
      throw new LoginError("rate_limited", "尝试过于频繁，请稍后再试");
    }

    const db = await getDbAsync();
    const [u] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .limit(1);

    if (!u || !u.passwordHash) {
      loginRateLimiter.recordFailure(username, source);
      throw new LoginError("invalid");
    }
    if (!u.active) throw new LoginError("disabled");

    const ok = await verify(u.passwordHash, password);
    if (!ok) {
      loginRateLimiter.recordFailure(username, source);
      // 不把凭证失败写成全局账号锁。否则任何知道用户名的人都能远程拒绝服务。
      throw new LoginError("invalid");
    }

    // 成功：只清当前来源失败桶；攻击来源的桶不能被另一设备的成功登录清掉。
    loginRateLimiter.clearPrincipalSource(username, source);
    // 清理旧版本遗留的数据库锁字段；新版本不再用它们实施自动锁定。
    if (u.failedLogins > 0 || u.lockedUntil) {
      await db
        .update(schema.users)
        .set({ failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(schema.users.id, u.id));
    }

    const scopes = await loadUserScopes(db, u.id);
    return {
      id: String(u.id),
      name: u.name,
      roles: u.roles as Role[],
      isApprover: u.isApprover,
      sessionVersion: u.sessionVersion,
      channelScope: scopes.channelScope,
      deptScope: scopes.deptScope,
      scopeVersion: u.sessionVersion,
    };
  },
});

/* ---------- NextAuth 配置 ---------- */

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

export const feishuEnabled = Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET);

async function findUserByUnionId(unionId: string) {
  const db = await getDbAsync();
  const [u] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.feishuUnionId, unionId))
    .limit(1);
  return u;
}

export const authConfig: NextAuthConfig = {
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  // 8 小时 JWT 会话；所有业务写操作通过 getFreshSessionUser 回查 active/session_version/角色，变更即时生效。
  session: { strategy: "jwt", maxAge: AUTH_SESSION_MAX_AGE, updateAge: 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    localProvider,
    ...(feishuEnabled ? [feishuProvider(FEISHU_APP_ID!, FEISHU_APP_SECRET!)] : []),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === "feishu") {
        // 账号由管理员预先开通并绑定 union_id，无自动注册
        if (!user.id) return false;
        const u = await findUserByUnionId(user.id);
        if (!u || !u.active) return false;
      }
      return true;
    },
    async jwt({ token, user, account }) {
      if (account?.provider === "feishu" && user?.id) {
        const u = await findUserByUnionId(user.id);
        if (u) {
          const scopes = await loadUserScopes(await getDbAsync(), u.id);
          token.userId = u.id;
          token.name = u.name;
          token.roles = u.roles as Role[];
          token.isApprover = u.isApprover;
          token.sessionVersion = u.sessionVersion;
          token.channelScope = scopes.channelScope;
          token.deptScope = scopes.deptScope;
          token.scopeVersion = u.sessionVersion;
        }
      } else if (user) {
        // local credentials：authorize 已返回完整用户（含 D62 范围）
        token.userId = Number(user.id);
        token.name = user.name;
        token.roles = user.roles ?? [];
        token.isApprover = user.isApprover ?? false;
        token.sessionVersion = user.sessionVersion;
        token.channelScope = user.channelScope ?? null;
        token.deptScope = user.deptScope ?? null;
        token.scopeVersion = user.scopeVersion ?? user.sessionVersion;
      } else if (token.userId != null) {
        // /api/auth/session bypasses middleware; do not let a legacy 30-day token renew here.
        if (!withinSessionLifetime(token)) return null;
        return refreshSessionIdentity(token);
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId != null ? String(token.userId) : "";
      session.user.name = token.name ?? null;
      session.user.roles = token.roles ?? [];
      session.user.isApprover = token.isApprover ?? false;
      session.user.sessionVersion = token.sessionVersion ?? -1;
      session.user.channelScope = token.channelScope ?? null;
      session.user.deptScope = token.deptScope ?? null;
      session.user.scopeVersion = token.scopeVersion ?? token.sessionVersion ?? -1;
      return session;
    },
  },
};

/** Preserve the full authorization policy while resolving cookie security per request. */
export function authConfigForRequest(request?: NextRequest): NextAuthConfig {
  return { ...authConfig, ...authCookieConfig(request) };
}
