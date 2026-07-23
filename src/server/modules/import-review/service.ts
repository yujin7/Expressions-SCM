/**
 * 复核工作台后端（《04》§4 ③）：别名异常认领 + 导入任务总览。
 * 认领一次，永久生效（写 aliases + 关闭异常）；忽略=显式拒绝解析（歧义码等）。
 */
import { desc, eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { aliasExceptions, importJobs, stagingRows } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { claimAlias } from "@/server/modules/dimension/resolver";
import { ApiError } from "@/server/modules/master/common";
import type { SessionUser } from "@/server/core/dto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const resolveDb = async (db?: AnyDb): Promise<AnyDb> => db ?? (await getDbAsync());

export async function listExceptions(
  opts: { status?: string; aliasType?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
) {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.status) conds.push(eq(aliasExceptions.status, opts.status as never));
  if (opts.aliasType) conds.push(eq(aliasExceptions.aliasType, opts.aliasType as never));
  const { and } = await import("drizzle-orm");
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select()
    .from(aliasExceptions)
    .where(where)
    .orderBy(aliasExceptions.aliasType, aliasExceptions.rawValue)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  const { sql } = await import("drizzle-orm");
  const [cnt] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(aliasExceptions)
    .where(where);
  return { data: rows, total: cnt?.total ?? 0 };
}

/** 认领：为原始值指定归属 id → 写别名 + 关闭异常（审计留痕） */
export async function claimException(
  user: SessionUser,
  id: number,
  targetId: number,
  dbArg?: AnyDb,
): Promise<void> {
  const db = await resolveDb(dbArg);
  const [exc] = await db.select().from(aliasExceptions).where(eq(aliasExceptions.id, id));
  if (!exc) throw new ApiError(404, "异常不存在");
  if (exc.status !== "open") throw new ApiError(409, `该异常已处理: ${exc.status}`);
  await claimAlias(db, { aliasType: exc.aliasType, rawValue: exc.rawValue, targetId, userId: user.id });
  await writeAudit(db, {
    userId: user.id, entity: "alias_exception", entityId: id, action: "claim",
    after: { aliasType: exc.aliasType, rawValue: exc.rawValue, targetId },
  });
}

/** 忽略：显式标记不解析（歧义码/垃圾值）；staging 中引用该值的行保持 pending 由导入方处置 */
export async function ignoreException(user: SessionUser, id: number, note?: string, dbArg?: AnyDb): Promise<void> {
  const db = await resolveDb(dbArg);
  const [exc] = await db.select().from(aliasExceptions).where(eq(aliasExceptions.id, id));
  if (!exc) throw new ApiError(404, "异常不存在");
  if (exc.status !== "open") throw new ApiError(409, `该异常已处理: ${exc.status}`);
  await db
    .update(aliasExceptions)
    .set({ status: "ignored", resolvedBy: user.id, resolvedAt: new Date() })
    .where(eq(aliasExceptions.id, id));
  await writeAudit(db, {
    userId: user.id, entity: "alias_exception", entityId: id, action: "ignore",
    after: { aliasType: exc.aliasType, rawValue: exc.rawValue, note: note ?? null },
  });
}

export async function listImportJobs(page: number, pageSize: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const rows = await db
    .select()
    .from(importJobs)
    .orderBy(desc(importJobs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const { sql } = await import("drizzle-orm");
  const [cnt] = await db.select({ total: sql<number>`count(*)::int` }).from(importJobs);
  return { data: rows, total: cnt?.total ?? 0 };
}

export async function getJobStagingSummary(jobId: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const { sql } = await import("drizzle-orm");
  return db
    .select({
      targetTable: stagingRows.targetTable,
      status: stagingRows.status,
      count: sql<number>`count(*)::int`,
    })
    .from(stagingRows)
    .where(eq(stagingRows.importJobId, jobId))
    .groupBy(stagingRows.targetTable, stagingRows.status);
}
