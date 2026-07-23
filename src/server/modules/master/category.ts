import { eq, ilike, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { categorySchema } from "./schemas";

const MAX_LEVEL = 3;

export async function listCategories(q: string, page: number, pageSize: number) {
  const db = await getDbAsync();
  const parent = alias(schema.categories, "parent");
  const where = q ? ilike(schema.categories.name, `%${q}%`) : undefined;
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        parentId: schema.categories.parentId,
        parentName: parent.name,
        level: schema.categories.level,
      })
      .from(schema.categories)
      .leftJoin(parent, eq(schema.categories.parentId, parent.id))
      .where(where)
      .orderBy(schema.categories.level, schema.categories.id)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.categories).where(where),
  ]);
  return { data: rows, total };
}

async function resolveLevel(parentId: number | null | undefined, selfId?: number): Promise<number> {
  if (!parentId) return 1;
  const db = await getDbAsync();
  if (selfId && parentId === selfId) throw new ApiError(400, "上级分类不能是自身");
  // 沿祖先链向上检查环 & 取层级
  const [parent] = await db.select().from(schema.categories).where(eq(schema.categories.id, parentId));
  if (!parent) throw new ApiError(400, "上级分类不存在");
  if (selfId) {
    let cursor = parent.parentId;
    for (let i = 0; i < MAX_LEVEL && cursor; i++) {
      if (cursor === selfId) throw new ApiError(400, "上级分类不能是自身的子分类");
      const [row] = await db.select().from(schema.categories).where(eq(schema.categories.id, cursor));
      cursor = row?.parentId ?? null;
    }
  }
  const level = parent.level + 1;
  if (level > MAX_LEVEL) throw new ApiError(400, `分类层级最多 ${MAX_LEVEL} 级`);
  return level;
}

export async function createCategory(input: unknown) {
  const v = categorySchema.parse(input);
  const level = await resolveLevel(v.parentId);
  const db = await getDbAsync();
  const [created] = await db
    .insert(schema.categories)
    .values({ name: v.name, parentId: v.parentId ?? null, level })
    .returning();
  return created;
}

export async function updateCategory(id: number, input: unknown) {
  const v = categorySchema.parse(input);
  const db = await getDbAsync();
  const [existing] = await db.select().from(schema.categories).where(eq(schema.categories.id, id));
  if (!existing) throw new ApiError(404, "分类不存在");
  const level = await resolveLevel(v.parentId, id);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.categories)
      .set({ name: v.name, parentId: v.parentId ?? null, level })
      .where(eq(schema.categories.id, id))
      .returning();
    // 级联刷新子孙层级（≤3 级，两层足够）
    const children = await tx.select().from(schema.categories).where(eq(schema.categories.parentId, id));
    if (children.length && level + 1 > MAX_LEVEL) {
      throw new ApiError(400, `该分类下存在子分类，调整后将超过 ${MAX_LEVEL} 级`);
    }
    for (const child of children) {
      await tx.update(schema.categories).set({ level: level + 1 }).where(eq(schema.categories.id, child.id));
      const grandchildren = await tx
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(eq(schema.categories.parentId, child.id));
      if (grandchildren.length && level + 2 > MAX_LEVEL) {
        throw new ApiError(400, `该分类下存在三级子分类，调整后将超过 ${MAX_LEVEL} 级`);
      }
      for (const gc of grandchildren) {
        await tx.update(schema.categories).set({ level: level + 2 }).where(eq(schema.categories.id, gc.id));
      }
    }
    return updated;
  });
}
