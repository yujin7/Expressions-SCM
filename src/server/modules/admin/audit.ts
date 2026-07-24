import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { maskSensitive } from "@/server/core/dto";
import { ApiError, type SessionUser } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/**
 * 审计日志查看（UAT 缺口 #2）：admin 或 finance（财务=只读审计员，UAT 横切裁定）。
 * audit_logs 仅追加、内容已按角色写入；出口仍过 maskSensitive——两角色均可见金额，
 * 此处为机械双保险（未来新增只读角色时自动兜底）。
 */
export function guardAuditView(user: SessionUser): void {
  if (user.roles.includes("admin") || user.roles.includes("finance")) return;
  throw new ApiError(403, "仅管理员或财务可查看审计日志");
}

export const auditQuerySchema = z.object({
  entity: z.string().trim().max(50).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(50).optional(),
  /** YYYY-MM-DD（Asia/Shanghai 闭区间） */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** entity/action 模糊 */
  q: z.string().trim().max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface AuditRow {
  id: number;
  createdAt: string; // ISO
  userId: number;
  userName: string | null;
  entity: string;
  entityId: number | null;
  action: string;
  before: unknown;
  after: unknown;
}

export async function listAuditLogs(
  user: SessionUser,
  query: unknown,
  dbArg?: AnyDb,
): Promise<{ rows: AuditRow[]; total: number; page: number; pageSize: number }> {
  guardAuditView(user);
  const qv = auditQuerySchema.parse(query ?? {});
  const db: AnyDb = dbArg ?? (await getDbAsync());

  const conds = [];
  if (qv.entity) conds.push(eq(auditLogs.entity, qv.entity));
  if (qv.entityId) conds.push(eq(auditLogs.entityId, qv.entityId));
  if (qv.userId) conds.push(eq(auditLogs.userId, qv.userId));
  if (qv.action) conds.push(eq(auditLogs.action, qv.action));
  // 业务日期 Asia/Shanghai：YYYY-MM-DD → 当日边界（+08:00）闭区间
  if (qv.from) conds.push(gte(auditLogs.createdAt, new Date(`${qv.from}T00:00:00+08:00`)));
  if (qv.to) conds.push(lte(auditLogs.createdAt, new Date(`${qv.to}T23:59:59.999+08:00`)));
  if (qv.q) conds.push(or(ilike(auditLogs.entity, `%${qv.q}%`), ilike(auditLogs.action, `%${qv.q}%`)));
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        createdAt: auditLogs.createdAt,
        userId: auditLogs.userId,
        userName: users.name,
        entity: auditLogs.entity,
        entityId: auditLogs.entityId,
        action: auditLogs.action,
        before: auditLogs.before,
        after: auditLogs.after,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(qv.pageSize)
      .offset((qv.page - 1) * qv.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(auditLogs).where(where),
  ]);

  const mapped: AuditRow[] = (rows as (Omit<AuditRow, "createdAt"> & { createdAt: Date })[]).map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
  }));
  return { rows: maskSensitive(mapped, user.roles), total, page: qv.page, pageSize: qv.pageSize };
}

/** 筛选下拉数据源：出现过的 entity 去重（量小，直接 distinct） */
export async function listAuditEntities(user: SessionUser, dbArg?: AnyDb): Promise<string[]> {
  guardAuditView(user);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: { entity: string }[] = await db
    .selectDistinct({ entity: auditLogs.entity })
    .from(auditLogs)
    .orderBy(auditLogs.entity);
  return rows.map((r) => r.entity);
}
