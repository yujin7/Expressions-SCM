import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTx = any;
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { SKU_TYPES, skuSchema } from "./schemas";
import {
  assessSkuStandardName,
  COMMERCIAL_ROLES,
  type CommercialRole,
} from "@/server/rules/sku-standardization";

type SkuType = (typeof SKU_TYPES)[number];

function parseTypes(raw: string | null): SkuType[] | undefined {
  if (!raw) return undefined;
  const types = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SkuType => (SKU_TYPES as readonly string[]).includes(s));
  return types.length ? types : undefined;
}

function parseCommercialRole(raw: string | null): CommercialRole | undefined {
  return COMMERCIAL_ROLES.includes(raw as CommercialRole) ? (raw as CommercialRole) : undefined;
}

export async function listSkus(
  q: string,
  page: number,
  pageSize: number,
  typeParam: string | null,
  roleParam?: string | null,
) {
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
  const commercialRole = parseCommercialRole(roleParam ?? null);
  if (commercialRole) conds.push(eq(schema.skus.commercialRole, commercialRole));
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
      shelfLifeDays: schema.skus.shelfLifeDays,
      nearExpiryDays: schema.skus.nearExpiryDays,
      brandId: schema.skus.brandId,
      brand: schema.brands.nameCn,
      channelId: schema.skus.channelId,
      channel: schema.channels.name,
      shortName: schema.skus.shortName,
      commercialRole: schema.skus.commercialRole,
      logisticsLeadDays: schema.skuParams.logisticsLeadDays,
      lifecycle: schema.skus.lifecycle,
      active: schema.skus.active,
    })
    .from(schema.skus)
    .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .leftJoin(schema.channels, eq(schema.skus.channelId, schema.channels.id))
    .leftJoin(schema.skuParams, eq(schema.skus.id, schema.skuParams.skuId));

  const [rawRows, [{ total }]] = await Promise.all([
    base.where(where).orderBy(schema.skus.code).limit(pageSize).offset((page - 1) * pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.skus)
      .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
      .where(where),
  ]);
  const rows = rawRows.map((row) => {
    const assessment = assessSkuStandardName(row);
    const namingStatus =
      !assessment.ready ? "incomplete" : assessment.suggestion === row.name ? "standard" : "ready";
    return { ...row, standardName: assessment.suggestion, namingStatus };
  });
  return { data: rows, total };
}

async function assertDimensionIds(tx: AnyTx, brandId?: number | null, channelId?: number | null): Promise<void> {
  if (brandId != null) {
    const [brand] = await tx.select({ id: schema.brands.id }).from(schema.brands).where(eq(schema.brands.id, brandId));
    if (!brand) throw new ApiError(400, "品牌不存在");
  }
  if (channelId != null) {
    const [channel] = await tx.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.id, channelId));
    if (!channel) throw new ApiError(400, "渠道不存在");
  }
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
  await assertDimensionIds(tx, v.brandId, v.channelId);
  const [created] = await tx
    .insert(schema.skus)
    .values({
      code: v.code,
      name: v.name, // 修复：W1 加列后 service 漏写，UI 建的 SKU 名称恒为空串
      brandId: v.brandId ?? null,
      channelId: v.channelId ?? null,
      shortName: v.shortName ?? null,
      commercialRole: v.commercialRole ?? "retail",
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
  if (v.logisticsLeadDays !== undefined) {
    await tx.insert(schema.skuParams).values({
      skuId: created.id,
      logisticsLeadDays: v.logisticsLeadDays ?? null,
      updatedBy: actor?.id ?? null,
    });
  }
  if (actor) {
    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku",
      entityId: created.id,
      action: "create",
      after: { ...created, logisticsLeadDays: v.logisticsLeadDays ?? null },
    });
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
  const [existingParams] = await tx
    .select({ logisticsLeadDays: schema.skuParams.logisticsLeadDays })
    .from(schema.skuParams)
    .where(eq(schema.skuParams.skuId, id));
  if (v.code !== existing.code) {
    throw new ApiError(409, "SKU 主码已用于历史关联，不可直接改码；请新建替代 SKU，并把旧码登记为别名");
  }
  await assertDimensionIds(tx, v.brandId, v.channelId);
  const [updated] = await tx
    .update(schema.skus)
    .set({
      code: v.code,
      name: v.name,
      brandId: v.brandId ?? null,
      channelId: v.channelId ?? null,
      shortName: v.shortName ?? null,
      commercialRole: v.commercialRole ?? existing.commercialRole,
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
  if (v.logisticsLeadDays !== undefined) {
    await tx.insert(schema.skuParams).values({
      skuId: id,
      logisticsLeadDays: v.logisticsLeadDays ?? null,
      updatedBy: actor?.id ?? null,
    }).onConflictDoUpdate({
      target: schema.skuParams.skuId,
      set: {
        logisticsLeadDays: v.logisticsLeadDays ?? null,
        updatedBy: actor?.id ?? null,
        updatedAt: new Date(),
      },
    });
  }
  if (actor) {
    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku",
      entityId: id,
      action: "update",
      before: { ...existing, logisticsLeadDays: existingParams?.logisticsLeadDays ?? null },
      after: { ...updated, ...(v.logisticsLeadDays !== undefined ? { logisticsLeadDays: v.logisticsLeadDays ?? null } : {}) },
    });
  }
  return updated;
  });
}

/** 人工采用服务端重算的标准名称；不接受客户端传建议名，也不修改稳定 SKU 主码。 */
export async function applySkuStandardName(id: number, actor: SessionUser, dbArg?: AnyTx) {
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
    const [row] = await tx
      .select({
        id: schema.skus.id,
        code: schema.skus.code,
        name: schema.skus.name,
        brand: schema.brands.nameCn,
        channel: schema.channels.name,
        shortName: schema.skus.shortName,
        version: schema.skus.version,
        spec: schema.skus.spec,
      })
      .from(schema.skus)
      .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
      .leftJoin(schema.channels, eq(schema.skus.channelId, schema.channels.id))
      .where(eq(schema.skus.id, id));
    if (!row) throw new ApiError(404, "SKU 不存在");
    const assessment = assessSkuStandardName(row);
    if (!assessment.suggestion) {
      const missing = assessment.missing.map((field) => field === "brand" ? "品牌" : "产品简称").join("、");
      throw new ApiError(400, `采用标准名称前请补齐：${missing}`);
    }
    if (row.name === assessment.suggestion) {
      return { id, code: row.code, name: row.name, unchanged: true };
    }
    const [updated] = await tx
      .update(schema.skus)
      .set({ name: assessment.suggestion, updatedAt: new Date() })
      .where(eq(schema.skus.id, id))
      .returning({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name });
    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku",
      entityId: id,
      action: "standardize_name",
      before: { name: row.name },
      after: { name: updated.name, stableCode: updated.code },
    });
    return { ...updated, unchanged: false };
  });
}
