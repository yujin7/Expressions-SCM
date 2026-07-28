/**
 * 用户管理（仅 admin）：建号/改角色/审批人开关/停用/重置密码。
 * 安全边界：
 * - passwordHash / feishuUnionId 永不出序列化边界；
 * - 不可停用自己、不可摘除自己的 admin 角色（防锁死）；
 * - 全部写路径 writeAudit；密码 argon2id（与 seed/登录一致）。
 */
import { hash, verify } from "@node-rs/argon2";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { ROLES } from "@/server/core/constants";
import { ApiError, type SessionUser } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface UserRow {
  id: number;
  username: string | null;
  name: string;
  roles: string[];
  isApprover: boolean;
  active: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  createdAt: string;
}

const toRow = (u: typeof schema.users.$inferSelect): UserRow => ({
  id: u.id,
  username: u.username,
  name: u.name,
  roles: u.roles as string[],
  isApprover: u.isApprover,
  active: u.active,
  mustChangePassword: u.mustChangePassword,
  lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null,
  createdAt: u.createdAt.toISOString(),
});

export function guardAdmin(user: SessionUser): void {
  if (!user.roles.includes("admin")) throw new ApiError(403, "仅管理员可管理用户");
}

export async function listUsers(dbArg?: AnyDb): Promise<UserRow[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: (typeof schema.users.$inferSelect)[] = await db.select().from(schema.users).orderBy(schema.users.id);
  return rows.map(toRow);
}

const passwordSchema = z.string().min(8, "密码至少 8 位").max(72);

export const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "账号至少 3 位")
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, "账号仅限字母/数字/_-."),
  name: z.string().trim().min(1, "姓名必填").max(50),
  password: passwordSchema,
  roles: z.array(z.enum(ROLES)).min(1, "至少一个角色"),
  isApprover: z.boolean().default(false),
});

export async function createUser(actor: SessionUser, input: unknown, dbArg?: AnyDb): Promise<UserRow> {
  guardAdmin(actor);
  const v = createUserSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const passwordHash = await hash(v.password);
  return db.transaction(async (tx: AnyDb) => {
    const [dup] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, v.username));
    if (dup) throw new ApiError(409, `账号已存在：${v.username}`);
    const [row] = await tx
      .insert(schema.users)
      .values({
        username: v.username,
        name: v.name,
        passwordHash,
        roles: v.roles,
        isApprover: v.isApprover,
        mustChangePassword: true, // 初始密码首登强制修改（UAT 缺口 #1）
      })
      .returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "user",
      entityId: row.id,
      action: "create",
      after: { username: v.username, name: v.name, roles: v.roles, isApprover: v.isApprover },
    });
    return toRow(row);
  });
}

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  isApprover: z.boolean().optional(),
  active: z.boolean().optional(),
  /** 重置密码（可选）；同时清除失败计数与锁定 */
  password: passwordSchema.optional(),
});

export async function updateUser(actor: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<UserRow> {
  guardAdmin(actor);
  const v = updateUserSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const passwordHash = v.password !== undefined ? await hash(v.password) : undefined;
  return db.transaction(async (tx: AnyDb) => {
    const [u]: (typeof schema.users.$inferSelect)[] = await tx.select().from(schema.users).where(eq(schema.users.id, id));
    if (!u) throw new ApiError(404, "用户不存在");
    if (id === actor.id) {
      if (v.active === false) throw new ApiError(400, "不可停用自己的账号");
      if (v.roles && !v.roles.includes("admin")) throw new ApiError(400, "不可摘除自己的管理员角色（防锁死）");
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (v.name !== undefined) patch.name = v.name;
    if (v.roles !== undefined) patch.roles = v.roles;
    if (v.isApprover !== undefined) patch.isApprover = v.isApprover;
    if (v.active !== undefined) patch.active = v.active;
    if (passwordHash !== undefined) {
      patch.passwordHash = passwordHash;
      patch.failedLogins = 0;
      patch.lockedUntil = null;
      patch.mustChangePassword = true; // 管理员重置的临时密码：首登强制修改
    }
    const identityChanged =
      v.roles !== undefined || v.isApprover !== undefined || v.active !== undefined || passwordHash !== undefined;
    if (identityChanged) patch.sessionVersion = sql`${schema.users.sessionVersion} + 1`;
    const [row] = await tx.update(schema.users).set(patch).where(eq(schema.users.id, id)).returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "user",
      entityId: id,
      action: "update",
      before: { name: u.name, roles: u.roles, isApprover: u.isApprover, active: u.active },
      after: {
        name: row.name,
        roles: row.roles,
        isApprover: row.isApprover,
        active: row.active,
        passwordReset: v.password !== undefined,
        sessionInvalidated: identityChanged,
      },
    });
    return toRow(row);
  });
}

/* ---------- 自助改密码（UAT 缺口 #1：任何登录用户；含首登强制修改） ---------- */

export const changeOwnPasswordSchema = z.object({
  oldPassword: z.string().min(1, "请输入原密码"),
  newPassword: passwordSchema,
});

/**
 * 自助改密码：校验原密码（argon2 verify），新密码 ≥8 位且须与原密码不同；
 * 成功后清除 mustChangePassword / failedLogins / lockedUntil。
 * 审计仅记事件，绝不落任何密码明文或哈希。
 */
export async function changeOwnPassword(userId: number, input: unknown, dbArg?: AnyDb): Promise<void> {
  const v = changeOwnPasswordSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [u]: (typeof schema.users.$inferSelect)[] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!u || !u.active) throw new ApiError(401, "账号已停用或不存在");
  if (!u.passwordHash) throw new ApiError(400, "该账号未设置本地密码（飞书账号请走飞书登录）");
  const ok = await verify(u.passwordHash, v.oldPassword);
  if (!ok) throw new ApiError(400, "原密码不正确");
  if (v.oldPassword === v.newPassword) throw new ApiError(400, "新密码不能与原密码相同");
  const passwordHash = await hash(v.newPassword);
  await db.transaction(async (tx: AnyDb) => {
    const [updated] = await tx
      .update(schema.users)
      .set({
        passwordHash,
        mustChangePassword: false,
        failedLogins: 0,
        lockedUntil: null,
        sessionVersion: sql`${schema.users.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.users.id, userId), eq(schema.users.sessionVersion, u.sessionVersion)))
      .returning({ id: schema.users.id });
    if (!updated) throw new ApiError(409, "账号已被同时更新，请重新登录后再试");
    await writeAudit(tx, {
      userId,
      entity: "user",
      entityId: userId,
      action: "change_password",
      after: { selfService: true, sessionInvalidated: true },
    });
  });
}
