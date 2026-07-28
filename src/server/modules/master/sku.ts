import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTx = any;
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
      brandId: schema.skus.brandId,
      lifecycle: schema.skus.lifecycle,
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

/**
 * @param actor 写入者。审计必须与写入落在**同一个事务**里。
 *   此前审计由路由层的 auditFromRoute 补记，而它用 getDbAsync() 拿的是**新的根连接**、
 *   且在服务事务提交之后才跑——进程在这中间挂掉就会留下「有数据、无审计」的行。
 *   CLAUDE.md 的铁律是「所有 service 写路径必须 writeAudit」，原子性是这条规则的实质。
 */
export async function createSku(input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = skuSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  const [created] = await tx
    .insert(schema.skus)
    .values({
      code: v.code,
      name: v.name, // 修复：W1 加列后 service 漏写，UI 建的 SKU 名称恒为空串
      brandId: v.brandId ?? null,
      lifecycle: v.lifecycle ?? "on_sale",
      spuId: v.spuId,
      skuType: v.skuType,
      baseUom: v.baseUom,
      spec: v.spec ?? null,
      version: v.version ?? null,
      prodMode: v.prodMode ?? null,
      lossCategory: v.lossCategory ?? null,
      shelfLifeDays: v.shelfLifeDays ?? null,
      nearExpiryDays: v.nearExpiryDays ?? null,
      active: v.active,
    })
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "sku", entityId: created.id, action: "create", after: created });
  }
  return created;
  });
}

export async function updateSku(id: number, input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = skuSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  const [existing] = await tx.select().from(schema.skus).where(eq(schema.skus.id, id));
  if (!existing) throw new ApiError(404, "SKU 不存在");
  const [updated] = await tx
    .update(schema.skus)
    .set({
      code: v.code,
      name: v.name,
      brandId: v.brandId ?? null,
      lifecycle: v.lifecycle ?? "on_sale",
      spuId: v.spuId,
      skuType: v.skuType,
      baseUom: v.baseUom,
      spec: v.spec ?? null,
      version: v.version ?? null,
      prodMode: v.prodMode ?? null,
      lossCategory: v.lossCategory ?? null,
      shelfLifeDays: v.shelfLifeDays ?? null,
      nearExpiryDays: v.nearExpiryDays ?? null,
      active: v.active,
      updatedAt: new Date(),
    })
    .where(eq(schema.skus.id, id))
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "sku", entityId: id, action: "update", before: existing, after: updated });
  }
  return updated;
  });
}
