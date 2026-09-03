/**
 * 用户数据范围写路径（D62，仅 admin）：user_data_scopes 同事务整体替换 + writeAudit(entity="user_data_scope")。
 *
 * 失效机制：范围变化即 users.session_version +1，使既有 JWT 立即失效（与角色/停用同一机制）；
 * 用户重新登录后 JWT 才携带新范围。范围未变化不 bump（避免无谓踢下线）。
 *
 * 语义：`channelIds` / `deptKeys` 任一为 undefined = 该类范围保持不变；[] = 清空该类（= 不限）。
 * 部门键 = 角色码（D61 部门先=角色），落库为 ROLES 索引（见 core/data-scope.ts）。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { ROLES } from "@/server/core/constants";
import { deptKeyToTargetId, loadUserScopes, type UserScopes } from "@/server/core/data-scope";
import { ApiError, type SessionUser } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export const setUserScopesSchema = z.object({
  channelIds: z.array(z.number().int().positive()).max(200).optional(),
  deptKeys: z.array(z.enum(ROLES)).optional(),
});
export type SetUserScopesInput = z.infer<typeof setUserScopesSchema>;

export interface UserScopesResult extends UserScopes {
  userId: number;
  /** 本次是否 bump 了 session_version（范围有变化） */
  sessionInvalidated: boolean;
}

function guardAdmin(user: { roles: string[] }): void {
  if (!user.roles.includes("admin")) throw new ApiError(403, "仅管理员可设置数据范围");
}

const sameList = <T>(a: readonly T[] | null, b: readonly T[] | null): boolean =>
  (a === null && b === null) || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]));

/** 只读：当前范围（admin） */
export async function getUserScopes(actor: SessionUser, userId: number, dbArg?: AnyDb): Promise<UserScopesResult> {
  guardAdmin(actor);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw new ApiError(404, "用户不存在");
  const scopes = await loadUserScopes(db, userId);
  return { userId, ...scopes, sessionInvalidated: false };
}

export async function setUserScopes(
  actor: SessionUser,
  userId: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<UserScopesResult> {
  guardAdmin(actor);
  const v = setUserScopesSchema.parse(input);
  if (v.channelIds === undefined && v.deptKeys === undefined) {
    throw new ApiError(400, "至少提供 channelIds 或 deptKeys 之一");
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    const [u]: (typeof schema.users.$inferSelect)[] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!u) throw new ApiError(404, "用户不存在");

    const before = await loadUserScopes(tx, userId);

    // 渠道必须是主档里存在的渠道（不校验 active：停用渠道的历史数据仍可授权查看）
    const nextChannels = v.channelIds === undefined ? before.channelScope : [...new Set(v.channelIds)].sort((a, b) => a - b);
    if (v.channelIds !== undefined && nextChannels && nextChannels.length > 0) {
      const found: { id: number }[] = await tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(inArray(schema.channels.id, nextChannels));
      const known = new Set(found.map((r) => r.id));
      const missing = nextChannels.filter((id) => !known.has(id));
      if (missing.length > 0) throw new ApiError(400, `渠道不存在：${missing.join(", ")}`);
    }
    const nextDepts = v.deptKeys === undefined ? before.deptScope : [...new Set(v.deptKeys)].sort();

    const after: UserScopes = {
      channelScope: nextChannels && nextChannels.length > 0 ? nextChannels : null,
      deptScope: nextDepts && nextDepts.length > 0 ? nextDepts : null,
    };
    const changed = !sameList(before.channelScope, after.channelScope) || !sameList(before.deptScope, after.deptScope);

    if (v.channelIds !== undefined) {
      await tx
        .delete(schema.userDataScopes)
        .where(and(eq(schema.userDataScopes.userId, userId), eq(schema.userDataScopes.scopeKind, "channel")));
      if (after.channelScope) {
        await tx.insert(schema.userDataScopes).values(
          after.channelScope.map((id) => ({ userId, scopeKind: "channel", targetId: id, createdBy: actor.id })),
        );
      }
    }
    if (v.deptKeys !== undefined) {
      await tx
        .delete(schema.userDataScopes)
        .where(and(eq(schema.userDataScopes.userId, userId), eq(schema.userDataScopes.scopeKind, "dept")));
      if (after.deptScope) {
        await tx.insert(schema.userDataScopes).values(
          after.deptScope.map((k) => ({ userId, scopeKind: "dept", targetId: deptKeyToTargetId(k), createdBy: actor.id })),
        );
      }
    }
    if (changed) {
      await tx
        .update(schema.users)
        .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1`, updatedAt: new Date() })
        .where(eq(schema.users.id, userId));
    }
    await writeAudit(tx, {
      userId: actor.id,
      entity: "user_data_scope",
      entityId: userId,
      action: "update",
      before: { channelIds: before.channelScope, deptKeys: before.deptScope },
      after: { channelIds: after.channelScope, deptKeys: after.deptScope, sessionInvalidated: changed },
    });
    return { userId, ...after, sessionInvalidated: changed };
  });
}
