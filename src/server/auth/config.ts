import { CredentialsSignin, type DefaultSession, type NextAuthConfig } from "next-auth";
// 仅为使 "next-auth/jwt" 模块进入编译，供下方 declare module 扩展 JWT 类型
import type {} from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import type { OAuth2Config } from "next-auth/providers";
import { verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import type { Role } from "@/server/core/constants";

/* ---------- 类型扩展：session/jwt 携带 userId/roles/isApprover ---------- */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      roles: Role[];
      isApprover: boolean;
    } & DefaultSession["user"];
  }
  interface User {
    roles?: Role[];
    isApprover?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: number;
    roles?: Role[];
    isApprover?: boolean;
  }
}

/* ---------- 登录错误码（前端 login-form 映射为中文提示） ---------- */

export type LoginErrorCode = "invalid" | "disabled" | "locked";

class LoginError extends CredentialsSignin {
  constructor(code: LoginErrorCode) {
    super(code);
    this.code = code;
  }
}

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/* ---------- 飞书 OAuth（仅当 FEISHU_APP_ID/SECRET 配置时启用） ---------- */

// TODO(P1): exact Feishu token/userinfo field mapping must be verified against current Feishu docs
// 当前按 v2 oauth/token（顶层 access_token）+ v1 user_info（{ code, msg, data: { union_id, name, avatar_url } }）
// 的常见返回形状做防御性映射；profile 回调兼容 data 嵌套与顶层两种形状。
type FeishuProfile = Record<string, unknown> & { data?: Record<string, unknown> };

function feishuProvider(appId: string, appSecret: string): OAuth2Config<FeishuProfile> {
  return {
    id: "feishu",
    name: "飞书",
    type: "oauth",
    clientId: appId,
    clientSecret: appSecret,
    authorization: {
      url: "https://open.feishu.cn/open-apis/authen/v1/authorize",
      params: { app_id: appId },
    },
    token: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
    userinfo: "https://open.feishu.cn/open-apis/authen/v1/user_info",
    checks: ["state"],
    client: { token_endpoint_auth_method: "client_secret_post" },
    profile(raw) {
      const d = (raw && typeof raw === "object" && raw.data && typeof raw.data === "object"
        ? raw.data
        : raw) as Record<string, unknown>;
      const unionId = typeof d.union_id === "string" ? d.union_id : "";
      return {
        // id = feishu union_id：signIn/jwt 回调据此查 users.feishuUnionId
        id: unionId,
        name: typeof d.name === "string" ? d.name : "飞书用户",
        image: typeof d.avatar_url === "string" ? d.avatar_url : null,
      };
    },
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
  async authorize(credentials) {
    const username = typeof credentials?.username === "string" ? credentials.username.trim() : "";
    const password = typeof credentials?.password === "string" ? credentials.password : "";
    if (!username || !password) throw new LoginError("invalid");

    const db = await getDbAsync();
    const [u] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .limit(1);

    if (!u || !u.passwordHash) throw new LoginError("invalid");
    if (!u.active) throw new LoginError("disabled");
    if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) throw new LoginError("locked");

    const ok = await verify(u.passwordHash, password);
    if (!ok) {
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

    // 成功：清零失败计数
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
        }
      } else if (user) {
        // local credentials：authorize 已返回完整用户
        token.userId = Number(user.id);
        token.name = user.name;
        token.roles = user.roles ?? [];
        token.isApprover = user.isApprover ?? false;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId != null ? String(token.userId) : "";
      session.user.name = token.name ?? null;
      session.user.roles = token.roles ?? [];
      session.user.isApprover = token.isApprover ?? false;
      return session;
    },
  },
};
