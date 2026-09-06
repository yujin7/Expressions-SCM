import { and, eq, ilike, or, sql } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { spuSchema } from "./schemas";
import { SELECTED_OPTIONS_LIMIT, selectedOptionsPredicate, type SelectedOptionValue } from "@/server/core/selected-options";

function buildWhere(q: string) {
  return q
    ? or(
        ilike(schema.spus.code, `%${q}%`),
        ilike(schema.spus.nameCn, `%${q}%`),
        ilike(schema.spus.nameEn, `%${q}%`),
      )
    : undefined;
}

export async function listSpus(q: string, page: number, pageSize: number, selectedValues?: SelectedOptionValue[]) {
  const db = await getDbAsync();
  const where = and(buildWhere(q), selectedOptionsPredicate(selectedValues, {
    id: schema.spus.id, text: [schema.spus.code, schema.spus.nameCn, schema.spus.nameEn],
  }));
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: schema.spus.id,
        code: schema.spus.code,
        nameCn: schema.spus.nameCn,
        nameEn: schema.spus.nameEn,
        categoryId: schema.spus.categoryId,
        categoryName: schema.categories.name,
      })
      .from(schema.spus)
      .leftJoin(schema.categories, eq(schema.spus.categoryId, schema.categories.id))
      .where(where)
      .orderBy(schema.spus.code)
      .limit(selectedValues === undefined ? pageSize : SELECTED_OPTIONS_LIMIT)
      .offset(selectedValues === undefined ? (page - 1) * pageSize : 0),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.spus).where(where),
  ]);
  return { data: rows, total };
}

/** 编码留空则自动取号 P+5位流水。
 *  《04》§4.1 裁决（连贯性审计 M4 修复）：走 doc_counters 原子 upsert 取号（prefix=SPU, bizDate=GLOBAL），
 *  杜绝 MAX+1 并发竞态——718+ SKU 批量建档时会高频取号。 */
async function nextSpuCode(db: DB): Promise<string> {
  const [row] = await db
    .insert(schema.docCounters)
    .values({ prefix: "SPU", bizDate: "GLOBAL", lastNo: 1 })
    .onConflictDoUpdate({
      target: [schema.docCounters.prefix, schema.docCounters.bizDate],
      set: { lastNo: sql`${schema.docCounters.lastNo} + 1` },
    })
    .returning({ lastNo: schema.docCounters.lastNo });
  let code = `P${String(row.lastNo).padStart(5, "0")}`;
  // 计数器可能落后于历史手工/种子编码（如 seed 的 P00001）——碰撞则继续取号直至空位
  for (let guard = 0; guard < 100000; guard++) {
    const [dup] = await db.select({ id: schema.spus.id }).from(schema.spus).where(eq(schema.spus.code, code));
    if (!dup) return code;
    const [again] = await db
      .insert(schema.docCounters)
      .values({ prefix: "SPU", bizDate: "GLOBAL", lastNo: 1 })
      .onConflictDoUpdate({
        target: [schema.docCounters.prefix, schema.docCounters.bizDate],
        set: { lastNo: sql`${schema.docCounters.lastNo} + 1` },
      })
      .returning({ lastNo: schema.docCounters.lastNo });
    code = `P${String(again.lastNo).padStart(5, "0")}`;
  }
  throw new Error("SPU 取号异常：连续 10 万次碰撞");
}

export async function createSpu(
  input: unknown,
  actor?: { id: number },
  dbOverride?: DB,
) {
  const v = spuSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  return db.transaction(async (tx) => {
    const code = v.code ?? (await nextSpuCode(tx as unknown as DB));
    const [created] = await tx
      .insert(schema.spus)
      .values({ code, nameCn: v.nameCn, nameEn: v.nameEn ?? null, categoryId: v.categoryId ?? null })
      .returning();
    if (actor) {
      await writeAudit(tx, {
        userId: actor.id,
        entity: "spu",
        entityId: created.id,
        action: "create",
        after: created,
      });
    }
    return created;
  });
}

export async function updateSpu(
  id: number,
  input: unknown,
  actor?: { id: number },
  dbOverride?: DB,
) {
  const v = spuSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(schema.spus).where(eq(schema.spus.id, id));
    if (!existing) throw new ApiError(404, "SPU 不存在");
    const [updated] = await tx
      .update(schema.spus)
      .set({
        code: v.code ?? existing.code,
        nameCn: v.nameCn,
        nameEn: v.nameEn ?? null,
        categoryId: v.categoryId ?? null,
      })
      .where(eq(schema.spus.id, id))
      .returning();
    if (actor) {
      await writeAudit(tx, {
        userId: actor.id,
        entity: "spu",
        entityId: id,
        action: "update",
        before: existing,
        after: updated,
      });
    }
    return updated;
  });
}

/* ── FEATURE 3：SPU 批量归组 ─────────────────────────────── */

import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import { writeAudit } from "@/server/core/audit";

const regroupSchema = z.object({
  skuIds: z.array(z.number().int().positive()).min(1, "至少选择一个 SKU").max(500, "单次最多 500 个"),
  mode: z.literal("move-in"),
});

/** SPU 成员 SKU 列表（含 needsReview 徽标数据） */
export async function listSpuMembers(spuId: number, dbOverride?: DB) {
  const db = dbOverride ?? (await getDbAsync());
  const [spu] = await db.select().from(schema.spus).where(eq(schema.spus.id, spuId));
  if (!spu) throw new ApiError(404, "SPU 不存在");
  const rows = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      skuType: schema.skus.skuType,
      baseUom: schema.skus.baseUom,
      spec: schema.skus.spec,
      active: schema.skus.active,
      attrs: schema.skus.attrs,
    })
    .from(schema.skus)
    .where(eq(schema.skus.spuId, spuId))
    .orderBy(schema.skus.code);
  return {
    data: rows.map((r) => {
      const attrs = (r.attrs ?? {}) as { needsReview?: unknown };
      const needsReview = Array.isArray(attrs.needsReview) ? (attrs.needsReview as string[]) : [];
      return { ...r, attrs: undefined, needsReview };
    }),
    total: rows.length,
  };
}

/**
 * 批量归组：把 SKU 移入本 SPU（含从其他 SPU 移出的语义——目标即本 SPU）。
 * 归组完成即消除该 SKU 的 attrs.needsReview 中的 "spu" 标记（人工已裁决）。
 */
export async function regroupSkus(user: { id: number }, spuId: number, input: unknown, dbOverride?: DB) {
  const v = regroupSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  return db.transaction(async (tx) => {
    const [spu] = await tx.select().from(schema.spus).where(eq(schema.spus.id, spuId));
    if (!spu) throw new ApiError(404, "SPU 不存在");
    const skuIds = [...new Set(v.skuIds)];
    const rows = await tx
      .select({ id: schema.skus.id, code: schema.skus.code, spuId: schema.skus.spuId, attrs: schema.skus.attrs })
      .from(schema.skus)
      .where(inArray(schema.skus.id, skuIds));
    const found = new Set(rows.map((r) => r.id));
    const missing = skuIds.filter((i) => !found.has(i));
    if (missing.length) throw new ApiError(400, `SKU 不存在：${missing.join("、")}`);

    const before: Record<string, number> = {};
    let moved = 0;
    for (const r of rows.sort((a, b) => a.id - b.id)) {
      before[r.code] = r.spuId;
      const attrs = (r.attrs ?? null) as Record<string, unknown> | null;
      let nextAttrs = attrs;
      if (attrs && Array.isArray(attrs.needsReview) && (attrs.needsReview as unknown[]).includes("spu")) {
        nextAttrs = { ...attrs, needsReview: (attrs.needsReview as string[]).filter((x) => x !== "spu") };
      }
      await tx
        .update(schema.skus)
        .set({ spuId, ...(nextAttrs !== attrs ? { attrs: nextAttrs } : {}), updatedAt: new Date() })
        .where(eq(schema.skus.id, r.id));
      moved += 1;
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "spu",
      entityId: spuId,
      action: "regroup",
      before: { memberSpuIds: before },
      after: { spuId, spuCode: spu.code, skuIds },
    });
    return { moved, spuId };
  });
}
