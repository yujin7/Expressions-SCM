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

/* ── 代决清单在应用内落库（W2）── */

/**
 * 复核队列此前**在应用里根本没法生成**：空态写着「请管理员运行 seed-review-items 脚本」，
 * 而那个脚本要 SSH 进机器、停掉 dev server（PGlite 独占）、还得先把那份 md 放到服务器上。
 * 于是「复核清单」这个功能对所有实际使用者都是只读的空页。
 *
 * 这里把同一件事搬进应用：**同一个解析器**（review/parse.parseReviewMarkdown，脚本与本函数共用）、
 * **同一条幂等规则**（按 title 去重，可重复导入）。差别只有三点，且都是往严格里改：
 *  - 仅 admin（代决清单是跨域主数据裁决的入口，不是谁都能往里塞事项）；
 *  - 同事务写审计（谁在什么时候导了多少条、来源标签是什么）——脚本一行审计都不写；
 *  - 有大小上限，避免有人把一个几十 MB 的文件贴进请求体。
 *
 * 不做的事：不生成、不推断、不合成任何复核项。输入里没有的行不会凭空出现——
 * 这是一次**导入**，不是一个"自动发现待复核事项"的引擎。
 */
export const REVIEW_IMPORT_ROLES = ["admin"] as const;

/** 请求体上限（字符）：那份代决清单实测 ~200KB，留 5 倍余量 */
export const REVIEW_IMPORT_MAX_CHARS = 1_000_000;

const importSchema = z.object({
  markdown: z.string().min(1, "请粘贴或上传代决清单内容").max(REVIEW_IMPORT_MAX_CHARS, "内容过大（上限 100 万字符）"),
  /** 来源标签（文件名/说明），只进审计，不进业务行 */
  source: z.string().trim().max(200).optional(),
});

export interface ReviewImportResult {
  /** 解析出的条目数（已按 title 去重） */
  parsed: number;
  /** 实际新增 */
  inserted: number;
  /** 因 title 已存在而跳过 */
  skipped: number;
  /** 新增条目的类别分布 */
  byCategory: { category: string; count: number }[];
}

export async function importReviewChecklist(
  user: Decider,
  input: unknown,
  dbOverride?: DB,
): Promise<ReviewImportResult> {
  try {
    requireRole(user, ...REVIEW_IMPORT_ROLES);
  } catch {
    throw new ApiError(403, "无权限：导入代决清单仅限管理员");
  }
  const v = importSchema.parse(input);
  const { parseReviewMarkdown } = await import("./parse");
  const items = parseReviewMarkdown(v.markdown);
  if (items.length === 0) {
    throw new ApiError(400, "未解析出任何代决条目（本格式只识别以「- 」开头的条目行）");
  }
  const db = dbOverride ?? (await getDbAsync());

  return db.transaction(async (tx) => {
    // 幂等：分批查已存在 title（与 scripts/seed-review-items.ts 同一条规则）
    const existing = new Set<string>();
    for (let i = 0; i < items.length; i += 500) {
      const chunk = items.slice(i, i + 500).map((x) => x.title);
      const rows = await tx
        .select({ title: schema.reviewItems.title })
        .from(schema.reviewItems)
        .where(inArray(schema.reviewItems.title, chunk));
      for (const r of rows) existing.add(r.title);
    }
    const fresh = items.filter((x) => !existing.has(x.title));
    for (let i = 0; i < fresh.length; i += 500) {
      await tx.insert(schema.reviewItems).values(
        fresh.slice(i, i + 500).map((x) => ({
          category: x.category,
          refType: x.refType,
          refKey: x.refKey,
          title: x.title,
          detail: x.detail,
        })),
      );
    }
    const byCategoryMap = new Map<string, number>();
    for (const x of fresh) byCategoryMap.set(x.category, (byCategoryMap.get(x.category) ?? 0) + 1);
    const byCategory = [...byCategoryMap.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

    await writeAudit(tx, {
      userId: user.id,
      entity: "review_item",
      entityId: null,
      action: "review_import",
      after: {
        source: v.source ?? null,
        parsed: items.length,
        inserted: fresh.length,
        skipped: items.length - fresh.length,
        byCategory,
      },
    });
    return { parsed: items.length, inserted: fresh.length, skipped: items.length - fresh.length, byCategory };
  });
}

/** 导入写守卫：回查 DB 新鲜身份（管理员角色可能刚被撤销），角色判定仍在 service 内 */
export async function guardReviewImport(): Promise<Decider & { isApprover: boolean }> {
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    return await getFreshSessionUser();
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
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
