import { CredentialsSignin, type DefaultSession, type NextAuthConfig } from "next-auth";
// 仅为使 "next-auth/jwt" 模块进入编译，供下方 declare module 扩展 JWT 类型
import type {} from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import type { OAuth2Config } from "next-auth/providers";
import { verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import type { Role } from "@/server/core/constants";
import { refreshSessionIdentity } from "./session-version";

/* ---------- 类型扩展：session/jwt 携带 userId/roles/isApprover ---------- */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      roles: Role[];
      isApprover: boolean;
      sessionVersion: number;
    } & DefaultSession["user"];
  }
  interface User {
    roles?: Role[];
    isApprover?: boolean;
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: number;
    roles?: Role[];
    isApprover?: boolean;
    sessionVersion?: number;
  }
}

/* ---------- 登录错误码（前端 login-form 映射为中文提示） ---------- */

export type LoginErrorCode = "invalid" | "disabled" | "locked" | "rate_limited";

class LoginError extends CredentialsSignin {
  constructor(code: LoginErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/* ---------- 登录限速（内存滑动窗口；单实例部署口径，多实例 1.1 移 Redis） ---------- */

const RATE_WINDOW_MS = 5 * 60 * 1000;
const IP_MAX_ATTEMPTS = 20; // 每 IP：全部登录尝试 20 次 / 5 分钟
const USER_MAX_FAILED = 10; // 每用户名：失败尝试 10 次 / 5 分钟（成功登录清零）
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
  failedByUser: new Map<string, number[]>(),
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
  /** 用户名失败窗口是否已满（只查不记） */
  userBlocked(username: string, now = Date.now()): boolean {
    const live = (this.failedByUser.get(username) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length === 0) this.failedByUser.delete(username);
    else this.failedByUser.set(username, live);
    return live.length >= USER_MAX_FAILED;
  },
  /** 记一次失败尝试（凭证类失败：用户不存在/密码错） */
  recordFailure(username: string, now = Date.now()): void {
    if (this.failedByUser.size > SWEEP_THRESHOLD) sweepStale(this.failedByUser, now);
    const live = (this.failedByUser.get(username) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    live.push(now);
    this.failedByUser.set(username, live);
  },
  clearUser(username: string): void {
    this.failedByUser.delete(username);
  },
  reset(): void {
    this.ipAttempts.clear();
    this.failedByUser.clear();
  },
};

/** x-forwarded-for 首跳（反代部署下为真实客户端 IP）；直连/不可得返回 null */
function clientIpOf(request: Request | undefined): string | null {
  const h = request?.headers;
  if (!h || typeof h.get !== "function") return null;
  const xff = h.get("x-forwarded-for");
  if (!xff) return null;
  const first = xff.split(",")[0]?.trim();
  return first || null;
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

/* ---------- 本地账号（argon2id + 连续失败锁定） ---------- */

const localProvider = Credentials({
  id: "local",
  name: "本地账号",
  credentials: {
    username: { label: "用户名" },
    password: { label: "密码", type: "password" },
  },
  async authorize(credentials, request) {
    // IP 滑动窗口（全部尝试计数）：x-forwarded-for 首跳；不可得时退化为仅用户名限速
    const ip = clientIpOf(request);
    if (ip && !loginRateLimiter.touchIp(ip)) {
      throw new LoginError("rate_limited", "尝试过于频繁，请稍后再试");
    }

    const username = typeof credentials?.username === "string" ? credentials.username.trim() : "";
    const password = typeof credentials?.password === "string" ? credentials.password : "";
    if (!username || !password) throw new LoginError("invalid");

    // 用户名失败窗口（仅失败计数，成功清零）——authorize 必有用户名，作 IP 缺失时的兜底
    if (loginRateLimiter.userBlocked(username)) {
      throw new LoginError("rate_limited", "尝试过于频繁，请稍后再试");
    }

    const db = await getDbAsync();
    const [u] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .limit(1);

    if (!u || !u.passwordHash) {
      loginRateLimiter.recordFailure(username);
      throw new LoginError("invalid");
    }
    if (!u.active) throw new LoginError("disabled");
    if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) throw new LoginError("locked");

    const ok = await verify(u.passwordHash, password);
    if (!ok) {
      loginRateLimiter.recordFailure(username);
      const failed = u.failedLogins + 1;
      if (failed >= MAX_FAILED_LOGINS) {
        // 达到阈值：锁定 15 分钟并清零计数
        await db
          .update(schema.users)
          .set({
            failedLogins: 0,
            lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60 * 1000),
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, u.id));
        throw new LoginError("locked");
      }
      await db
        .update(schema.users)
        .set({ failedLogins: failed, updatedAt: new Date() })
        .where(eq(schema.users.id, u.id));
      throw new LoginError("invalid");
    }

    // 成功：清零失败计数（含内存限速窗口）
    loginRateLimiter.clearUser(username);
    if (u.failedLogins > 0 || u.lockedUntil) {
      await db
        .update(schema.users)
        .set({ failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(schema.users.id, u.id));
    }

    return {
      id: String(u.id),
      name: u.name,
      roles: u.roles as Role[],
      isApprover: u.isApprover,
      sessionVersion: u.sessionVersion,
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
  // 规格要求 DB 会话（角色变更即时生效）——MVP W1 用 JWT，W2 换 DB 会话/加角色版本戳。deviation logged
  session: { strategy: "jwt", maxAge: 8 * 60 * 60, updateAge: 60 * 60 },
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
          token.userId = u.id;
          token.name = u.name;
          token.roles = u.roles as Role[];
          token.isApprover = u.isApprover;
          token.sessionVersion = u.sessionVersion;
        }
      } else if (user) {
        // local credentials：authorize 已返回完整用户
        token.userId = Number(user.id);
        token.name = user.name;
        token.roles = user.roles ?? [];
        token.isApprover = user.isApprover ?? false;
        token.sessionVersion = user.sessionVersion;
      } else if (token.userId != null) {
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
      return session;
    },
  },
};
