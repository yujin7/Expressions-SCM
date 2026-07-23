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

/** 编码留空则自动取号 P+5位流水（主数据流水，非单据号，不走 doc_counter） */
async function nextSpuCode(): Promise<string> {
  const db = await getDbAsync();
  const [row] = await db
    .select({ max: sql<string | null>`max(${schema.spus.code})` })
    .from(schema.spus)
    .where(sql`${schema.spus.code} ~ '^P[0-9]{5}$'`);
  const next = row?.max ? parseInt(row.max.slice(1), 10) + 1 : 1;
  return `P${String(next).padStart(5, "0")}`;
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
