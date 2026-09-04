import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync, schema, type DB } from "@/db";
import { writeAudit } from "@/server/core/audit";
import { requireRole } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";

/**
 * 在案复核清单（review_items）：数据填充代决记录的复核工作流。
 * 决策角色：PMC/采购/仓管/财务任一（admin 兜底）——代决覆盖主数据/库存/费用多域。
 */

export const REVIEW_DECIDE_ROLES = ["pmc", "purchasing", "warehouse", "finance"] as const;

export const REVIEW_CATEGORIES = [
  "spu_cluster",
  "bom_version",
  "segment",
  "shell_brand",
  "blocked_sku",
  "activation_sample",
  "uncoded",
  // W2-#7：运营提报「标红且未处置」的投影（refType=ops_demand_submission，责任角色 pmc）
  "ops_demand",
  "other",
] as const;

const REVIEW_STATUSES = ["open", "done", "overruled"] as const;

const decideSchema = z.object({
  status: z.enum(REVIEW_STATUSES),
  note: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(500, "复核意见不超过 500 字").optional(),
  ),
});

const bulkSchema = decideSchema.extend({
  ids: z.array(z.number().int().positive()).min(1, "至少选择一条").max(500, "单次最多 500 条"),
});

export interface ReviewListFilter {
  category?: string;
  status?: string;
  q?: string;
  page: number;
  pageSize: number;
}

function buildWhere(f: { category?: string; status?: string; q?: string }) {
  const conds = [];
  if (f.category && (REVIEW_CATEGORIES as readonly string[]).includes(f.category)) {
    conds.push(eq(schema.reviewItems.category, f.category));
  }
  if (f.status && (REVIEW_STATUSES as readonly string[]).includes(f.status)) {
    conds.push(eq(schema.reviewItems.status, f.status));
  }
  if (f.q) {
    conds.push(
      or(
        ilike(schema.reviewItems.title, `%${f.q}%`),
        ilike(schema.reviewItems.detail, `%${f.q}%`),
        ilike(schema.reviewItems.refKey, `%${f.q}%`),
      ),
    );
  }
  return conds.length ? and(...conds) : undefined;
}

export async function listReviewItems(f: ReviewListFilter, dbOverride?: DB) {
  const db = dbOverride ?? (await getDbAsync());
  const where = buildWhere(f);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(schema.reviewItems)
      .where(where)
      .orderBy(sql`case when ${schema.reviewItems.status} = 'open' then 0 else 1 end`, schema.reviewItems.id)
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.reviewItems).where(where),
  ]);
  return { data: rows, total };
}

/** 类别×状态计数（tabs 徽标 + 进度头） */
export async function countReviewItems(dbOverride?: DB) {
  const db = dbOverride ?? (await getDbAsync());
  const rows = await db
    .select({
      category: schema.reviewItems.category,
      status: schema.reviewItems.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.reviewItems)
    .groupBy(schema.reviewItems.category, schema.reviewItems.status);
  return { counts: rows };
}

type Decider = { id: number; name: string; roles: string[] };

function assertDecider(user: Decider): void {
  try {
    requireRole(user, ...REVIEW_DECIDE_ROLES);
  } catch {
    throw new ApiError(403, "无权限：需要生产计划/采购/仓管/财务任一角色");
  }
}

/** 单条改判：通过(done)/改判(overruled，宜附意见)/重开(open，清空裁决人) */
export async function decideReviewItem(user: Decider, id: number, input: unknown, dbOverride?: DB) {
  assertDecider(user);
  const v = decideSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  const [before] = await db.select().from(schema.reviewItems).where(eq(schema.reviewItems.id, id));
  if (!before) throw new ApiError(404, "复核项不存在");
  const reopened = v.status === "open";
  const [after] = await db
    .update(schema.reviewItems)
    .set({
      status: v.status,
      note: v.note ?? (reopened ? null : before.note),
      decidedBy: reopened ? null : user.id,
      decidedAt: reopened ? null : new Date(),
    })
    .where(eq(schema.reviewItems.id, id))
    .returning();
  await writeAudit(db, {
    userId: user.id,
    entity: "review_item",
    entityId: id,
    action: v.status === "done" ? "review_done" : v.status === "overruled" ? "review_overrule" : "review_reopen",
    before: { status: before.status, note: before.note },
    after: { status: after.status, note: after.note },
  });
  return after;
}

/** 批量改判（勾选后一键通过等）；审计按批记 1 行（ids+状态） */
export async function bulkDecideReviewItems(user: Decider, input: unknown, dbOverride?: DB) {
  assertDecider(user);
  const v = bulkSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  const reopened = v.status === "open";
  const rows = await db
    .update(schema.reviewItems)
    .set({
      status: v.status,
      ...(v.note !== undefined ? { note: v.note } : {}),
      decidedBy: reopened ? null : user.id,
      decidedAt: reopened ? null : new Date(),
    })
    .where(inArray(schema.reviewItems.id, v.ids))
    .returning({ id: schema.reviewItems.id });
  await writeAudit(db, {
    userId: user.id,
    entity: "review_item",
    entityId: null,
    action: "review_bulk",
    after: { status: v.status, note: v.note ?? null, ids: rows.map((r) => r.id) },
  });
  return { updated: rows.length };
}

/** 路由写守卫：回查 DB 新鲜身份（体检 #5）+ 决策角色校验 */
export async function guardReviewWrite(): Promise<Decider & { isApprover: boolean }> {
  let user: Decider & { isApprover: boolean };
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    user = await getFreshSessionUser();
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
  assertDecider(user);
  return user;
}

/* ── UAT 反馈直录（0724 改进波：页面反馈→复核清单 category=uat_feedback） ── */

const feedbackSchema = z.object({
  page: z.string().trim().max(200),
  content: z.string().trim().min(2, "请描述问题或建议").max(1000),
});

export async function createFeedback(user: Decider, input: unknown, dbOverride?: DB): Promise<{ id: number }> {
  const v = feedbackSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  const [row] = await db
    .insert(schema.reviewItems)
    .values({
      category: "uat_feedback",
      refType: null,
      refKey: v.page,
      title: `【反馈】${v.content.slice(0, 60)}${v.content.length > 60 ? "…" : ""}`,
      detail: `页面：${v.page}\n提交人：${user.name}\n内容：${v.content}`,
      status: "open",
    })
    .returning({ id: schema.reviewItems.id });
  await writeAudit(db, { userId: user.id, entity: "review_item", entityId: row.id, action: "feedback", after: { page: v.page } });
  return { id: row.id };
}
