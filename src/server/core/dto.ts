import { PRICE_VISIBLE_ROLES, ROLE_LABELS, SENSITIVE_FIELDS } from "./constants";

/**
 * R9 脱敏唯一收口：所有实体 dto / 导出 / RSC 载荷必须经过 maskSensitive。
 * 前端隐藏不算数——数据离开 server 层之前在这里剥掉敏感字段。
 */

const SENSITIVE_SET: ReadonlySet<string> = new Set<string>(SENSITIVE_FIELDS);
const VISIBLE_SET: ReadonlySet<string> = new Set<string>(PRICE_VISIBLE_ROLES);

/** roles ∩ PRICE_VISIBLE_ROLES ≠ ∅（采购/PMC/财务/管理员可见敏感价格） */
export function canSeePrices(roles: string[]): boolean {
  return roles.some((r) => VISIBLE_SET.has(r));
}

function deepStrip(value: unknown, strip: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => deepStrip(v, strip));
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    // 仅递归纯对象；Date/Decimal 等类实例按叶子值原样保留
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (strip && SENSITIVE_SET.has(k)) continue; // 直接删除敏感键
        out[k] = deepStrip(v, strip);
      }
      return out;
    }
  }
  return value;
}

/**
 * 深拷贝并按角色剥离 SENSITIVE_FIELDS 中的所有键（递归对象/数组）。
 * 不可变：绝不修改入参。
 */
export function maskSensitive<T>(data: T, roles: string[]): T {
  return deepStrip(data, !canSeePrices(roles)) as T;
}

export interface SessionUser {
  id: number;
  name: string;
  roles: string[];
  isApprover: boolean;
  /** JWT 身份版本；直接调用 service 的测试/后台任务可省略，HTTP 写路径必须具备 */
  sessionVersion?: number;
}

/** Authentication/session freshness failure that routes must return as 401, never as a logged 500. */
export class SessionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionAuthError";
  }
}

/** 从 NextAuth 会话取当前用户；未登录抛错。（动态 import 保持本模块纯函数可独立单测） */
export async function getSessionUser(): Promise<SessionUser> {
  const { auth } = await import("@/server/auth");
  const session = await auth();
  const u = session?.user;
  if (!u || !u.id) throw new SessionAuthError("未登录");
  return {
    id: Number(u.id),
    name: u.name ?? "",
    roles: u.roles ?? [],
    isApprover: u.isApprover ?? false,
    sessionVersion: u.sessionVersion,
  };
}

/** 要求任一角色（admin 恒通过），否则抛错 */
export function requireRole(user: { roles: string[] }, ...roles: string[]): void {
  if (user.roles.includes("admin")) return;
  if (roles.some((r) => user.roles.includes(r))) return;
  const labels = roles.map((r) => ROLE_LABELS[r as keyof typeof ROLE_LABELS] ?? r);
  throw new Error(`无权限：需要${labels.join("/")}角色`);
}


/**
 * 写操作专用（体检 #5）：JWT 会话下角色/停用不即时生效——写路径必须回查 DB 取新鲜身份。
 * 停用/角色/审批权/密码版本变化的用户在此被立即拦截。
 */
export async function getFreshSessionUser(): Promise<{ id: number; name: string; roles: string[]; isApprover: boolean }> {
  const tokenUser = await getSessionUser();
  const { getDbAsync } = await import("@/db");
  const { users } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDbAsync();
  const [row] = await db.select().from(users).where(eq(users.id, tokenUser.id));
  if (!row || !row.active) throw new SessionAuthError("账号已停用或不存在");
  if (tokenUser.sessionVersion == null || tokenUser.sessionVersion !== row.sessionVersion) {
    throw new SessionAuthError("会话已失效，请重新登录");
  }
  return { id: row.id, name: row.name, roles: row.roles, isApprover: row.isApprover };
}
