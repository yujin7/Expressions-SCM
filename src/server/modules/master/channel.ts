import { eq, ilike, or, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { channelSchema, channelUpdateSchema } from "@/server/modules/master/schemas";

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

/* ────────────────────── 写路径（审计 #11） ────────────────────── */

/**
 * 为什么必须有：`channels` 此前唯一的写入者是 seed，而 SKU 主档、周期补录、分层、
 * 驾驶舱等六个页面都拿它当选择器。业务新开一个店或一个部门，只能改 seed 重播数据库——
 * 于是渠道维在生产上是冻结的。
 *
 * 口径：
 *  - `code` 是别名解析与外部映射的稳定业务键，建后不可改（改码=改身份，历史关系会静默错位）；
 *  - 停用不是删除：存量 SKU 仍引用它，`listChannels` 也照常返回停用渠道
 *    （隐藏会把真实关系变成不可见 ID）；
 *  - 写审计与写入同一事务（entity=channel）。
 */
export async function createChannel(input: unknown, actor: SessionUser, dbArg?: AnyDb) {
  const v = channelSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [dup] = await tx.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.code, v.code));
    if (dup) throw new ApiError(409, `渠道编码 ${v.code} 已存在`);
    const [created] = await tx
      .insert(schema.channels)
      .values({ code: v.code, name: v.name, kind: v.kind, active: v.active ?? true })
      .returning();
    await writeAudit(tx, { userId: actor.id, entity: "channel", entityId: created.id, action: "create", after: created });
    return created;
  });
}

export async function updateChannel(id: number, input: unknown, actor: SessionUser, dbArg?: AnyDb) {
  const raw = (input ?? {}) as Record<string, unknown>;
  const v = channelUpdateSchema.parse(raw);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [existing] = await tx.select().from(schema.channels).where(eq(schema.channels.id, id));
    if (!existing) throw new ApiError(404, "渠道不存在");
    /* 主码稳定：CrudTable 的编辑表单会把整行回传，带上同值的 code 属正常；
       只有真的想改码才报错——把「不可改」说清楚，而不是静默忽略。 */
    const nextCode = typeof raw.code === "string" ? raw.code.trim() : undefined;
    if (nextCode !== undefined && nextCode !== existing.code) {
      throw new ApiError(409, "渠道编码是别名解析与外部映射的稳定业务键，不可修改；请新建渠道并把旧渠道停用");
    }
    const [updated] = await tx
      .update(schema.channels)
      .set({
        name: v.name ?? existing.name,
        kind: v.kind ?? existing.kind,
        active: v.active ?? existing.active,
      })
      .where(eq(schema.channels.id, id))
      .returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "channel",
      entityId: id,
      action: v.active === true && existing.active === false ? "activate" : "update",
      before: existing,
      after: updated,
    });
    return updated;
  });
}

export async function getChannel(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [row] = await db.select().from(schema.channels).where(eq(schema.channels.id, id));
  if (!row) throw new ApiError(404, "渠道不存在");
  return row;
}
