import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { SKU_TYPES, skuSchema } from "./schemas";

type SkuType = (typeof SKU_TYPES)[number];

function parseTypes(raw: string | null): SkuType[] | undefined {
  if (!raw) return undefined;
  const types = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SkuType => (SKU_TYPES as readonly string[]).includes(s));
  return types.length ? types : undefined;
}

export async function listSkus(q: string, page: number, pageSize: number, typeParam: string | null) {
  const db = await getDbAsync();
  const conds = [];
  if (q) {
    conds.push(
      or(
        ilike(schema.skus.code, `%${q}%`),
        ilike(schema.skus.name, `%${q}%`),
        ilike(schema.spus.nameCn, `%${q}%`),
        ilike(schema.skus.spec, `%${q}%`),
      ),
    );
  }
  const types = parseTypes(typeParam);
  if (types) conds.push(inArray(schema.skus.skuType, types));
  const where = conds.length ? and(...conds) : undefined;

  const base = db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      spuId: schema.skus.spuId,
      spuCode: schema.spus.code,
      spuNameCn: schema.spus.nameCn,
      skuType: schema.skus.skuType,
      baseUom: schema.skus.baseUom,
      spec: schema.skus.spec,
      version: schema.skus.version,
      prodMode: schema.skus.prodMode,
      lossCategory: schema.skus.lossCategory,
      active: schema.skus.active,
    })
    .from(schema.skus)
    .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id));

  const [rows, [{ total }]] = await Promise.all([
    base.where(where).orderBy(schema.skus.code).limit(pageSize).offset((page - 1) * pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.skus)
      .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
      .where(where),
  ]);
  return { data: rows, total };
}

export async function createSku(input: unknown) {
  const v = skuSchema.parse(input);
  const db = await getDbAsync();
  const [created] = await db
    .insert(schema.skus)
    .values({
      code: v.code,
      spuId: v.spuId,
      skuType: v.skuType,
      baseUom: v.baseUom,
      spec: v.spec ?? null,
      version: v.version ?? null,
      prodMode: v.prodMode ?? null,
      lossCategory: v.lossCategory ?? null,
      active: v.active,
    })
    .returning();
  return created;
}

export async function updateSku(id: number, input: unknown) {
  const v = skuSchema.parse(input);
  const db = await getDbAsync();
  const [existing] = await db.select().from(schema.skus).where(eq(schema.skus.id, id));
  if (!existing) throw new ApiError(404, "SKU 不存在");
  const [updated] = await db
    .update(schema.skus)
    .set({
      code: v.code,
      spuId: v.spuId,
      skuType: v.skuType,
      baseUom: v.baseUom,
      spec: v.spec ?? null,
      version: v.version ?? null,
      prodMode: v.prodMode ?? null,
      lossCategory: v.lossCategory ?? null,
      active: v.active,
      updatedAt: new Date(),
    })
    .where(eq(schema.skus.id, id))
    .returning();
  return updated;
}
