import { eq, ilike, or, sql } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { spuSchema } from "./schemas";

function buildWhere(q: string) {
  return q
    ? or(
        ilike(schema.spus.code, `%${q}%`),
        ilike(schema.spus.nameCn, `%${q}%`),
        ilike(schema.spus.nameEn, `%${q}%`),
      )
    : undefined;
}

export async function listSpus(q: string, page: number, pageSize: number) {
  const db = await getDbAsync();
  const where = buildWhere(q);
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
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.spus).where(where),
  ]);
  return { data: rows, total };
}

/** 编码留空则自动取号 P+5位流水。
 *  《04》§4.1 裁决（连贯性审计 M4 修复）：走 doc_counter 行锁取号（prefix=SPU, bizDate=GLOBAL），
 *  杜绝 MAX+1 并发竞态——718+ SKU 批量建档时会高频取号。 */
async function nextSpuCode(): Promise<string> {
  const db = await getDbAsync();
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

export async function createSpu(input: unknown) {
  const v = spuSchema.parse(input);
  const db = await getDbAsync();
  const code = v.code ?? (await nextSpuCode());
  const [created] = await db
    .insert(schema.spus)
    .values({ code, nameCn: v.nameCn, nameEn: v.nameEn ?? null, categoryId: v.categoryId ?? null })
    .returning();
  return created;
}

export async function updateSpu(id: number, input: unknown) {
  const v = spuSchema.parse(input);
  const db = await getDbAsync();
  const [existing] = await db.select().from(schema.spus).where(eq(schema.spus.id, id));
  if (!existing) throw new ApiError(404, "SPU 不存在");
  const [updated] = await db
    .update(schema.spus)
    .set({
      code: v.code ?? existing.code,
      nameCn: v.nameCn,
      nameEn: v.nameEn ?? null,
      categoryId: v.categoryId ?? null,
    })
    .where(eq(schema.spus.id, id))
    .returning();
  return updated;
}
