import { eq } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import type { Role } from "@/server/core/constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB 注入供 PGlite 回归测试复用
type AnyDb = any;

export interface VersionedSessionToken {
  userId?: number;
  sessionVersion?: number;
  name?: string | null;
  roles?: Role[];
  isApprover?: boolean;
  [key: string]: unknown;
}

/**
 * 服务端会话刷新：
 * - 旧 token 没有 sessionVersion → 拒绝，部署后一次性重新登录；
 * - 用户停用/删除或版本不匹配 → 拒绝；
 * - 版本一致时刷新姓名/角色/审批权，读写两侧不再信任 8 小时旧权限。
 *
 * Edge middleware 仍只做粗粒度“有无签名 token”检查，避免把数据库驱动拖入 Edge；
 * RSC/API 的完整 auth() 与所有写路径会执行本校验。
 */
export async function refreshSessionIdentity<T extends VersionedSessionToken>(
  token: T,
  dbArg?: AnyDb,
): Promise<T | null> {
  if (!Number.isInteger(token.userId) || !Number.isInteger(token.sessionVersion)) return null;
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [row] = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      roles: schema.users.roles,
      isApprover: schema.users.isApprover,
      active: schema.users.active,
      sessionVersion: schema.users.sessionVersion,
    })
    .from(schema.users)
    .where(eq(schema.users.id, token.userId as number))
    .limit(1);
  if (!row?.active || row.sessionVersion !== token.sessionVersion) return null;
  return {
    ...token,
    name: row.name,
    roles: row.roles as Role[],
    isApprover: row.isApprover,
  };
}
