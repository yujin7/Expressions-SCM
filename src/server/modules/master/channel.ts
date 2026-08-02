import { ilike, or, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { resolveDb, type AnyDb } from "@/server/core/svc";

function buildWhere(q: string) {
  return q
    ? or(
        ilike(schema.channels.code, `%${q}%`),
        ilike(schema.channels.name, `%${q}%`),
      )
    : undefined;
}

/**
 * SKU 等主数据表单的渠道选项源。
 *
 * 停用渠道仍返回：存量 SKU 可能仍引用它，编辑时隐藏会把真实关系变成不可见 ID。
 * 调用方如只允许新建时选活跃渠道，应使用 RemoteSelect.filterRow 显式筛选。
 */
export async function listChannels(q: string, page: number, pageSize: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const where = buildWhere(q);
  const [data, [{ total }]] = await Promise.all([
    db
      .select({
        id: schema.channels.id,
        code: schema.channels.code,
        name: schema.channels.name,
        kind: schema.channels.kind,
        active: schema.channels.active,
      })
      .from(schema.channels)
      .where(where)
      .orderBy(schema.channels.code, schema.channels.id)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.channels).where(where),
  ]);
  return { data, total };
}
