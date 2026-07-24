/**
 * 用户管理（仅 admin）：建号/改角色/审批人开关/停用/重置密码。
 * 安全边界：
 * - passwordHash / feishuUnionId 永不出序列化边界；
 * - 不可停用自己、不可摘除自己的 admin 角色（防锁死）；
 * - 全部写路径 writeAudit；密码 argon2id（与 seed/登录一致）。
 */
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { ROLES } from "@/server/core/constants";
import { ApiError, type SessionUser } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface UserRow {
  id: number;
  username: string | null;
  name: string;
  roles: string[];
  isApprover: boolean;
  active: boolean;
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
  const [dup] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, v.username));
  if (dup) throw new ApiError(409, `账号已存在：${v.username}`);
  const passwordHash = await hash(v.password);
  const [row] = await db
    .insert(schema.users)
    .values({ username: v.username, name: v.name, passwordHash, roles: v.roles, isApprover: v.isApprover })
    .returning();
  await writeAudit(db, {
    userId: actor.id,
    entity: "user",
    entityId: row.id,
    action: "create",
    after: { username: v.username, name: v.name, roles: v.roles, isApprover: v.isApprover },
  });
  return toRow(row);
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
  const [u]: (typeof schema.users.$inferSelect)[] = await db.select().from(schema.users).where(eq(schema.users.id, id));
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
  if (v.password !== undefined) {
    patch.passwordHash = await hash(v.password);
    patch.failedLogins = 0;
    patch.lockedUntil = null;
  }
  const [row] = await db.update(schema.users).set(patch).where(eq(schema.users.id, id)).returning();
  await writeAudit(db, {
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
    },
  });
  return toRow(row);
}
