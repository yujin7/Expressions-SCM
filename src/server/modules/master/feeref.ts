import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDateSchema } from "@/server/core/business-date-schema";
import { getDbAsync, schema, type DB } from "@/db";
import { writeAudit } from "@/server/core/audit";
import { dMoney } from "@/server/core/decimal";
import { requireRole } from "@/server/core/dto";
import { ApiError } from "./common";

/**
 * 加工费参考价（processing_fee_refs，《04》§2）：R1 比价基准来源之一，feeds woDocs.feeRatePlan。
 * feeRate 属 R9 敏感字段——route 层必须经 maskSensitive 按角色剥离后再出网。
 * 写权限：采购（admin 兜底）。表无停用标志（uq_fee_sku_sup_date 天然按生效日版本化），故无 deactivate。
 */

const dateStr = businessDateSchema;
const feeRateVal = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  z
    .union([z.string(), z.number()])
    .nullable()
    .refine((v) => v == null || (/^\d+(\.\d{1,4})?$/.test(String(v)) && Number(String(v)) >= 0), "加工费必须为非负数"),
);

const FEE_TYPES = ["OEM填充", "保税加工", "保税仓操作费", "其他"] as const; // D34
const createSchema = z.object({
  skuId: z.number().int().positive({ message: "必须选择 SKU" }),
  supplierId: z.number().int().positive({ message: "必须选择加工厂" }),
  feeRate: feeRateVal.optional(), // BOM 文件常缺价——可空待补录
  effectiveDate: dateStr,
  feeType: z.enum(FEE_TYPES).optional().default("OEM填充"),
  note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(200).optional()),
});

const updateSchema = z.object({
  feeRate: feeRateVal.optional(),
  feeType: z.enum(FEE_TYPES).optional(),
  effectiveDate: dateStr.optional(),
  note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(200).nullable().optional()),
});

function normFee(v: string | number | null | undefined): string | null {
  return v == null ? null : dMoney(v);
}

export async function listFeeRefs(
  f: { q: string; page: number; pageSize: number; supplierId?: number },
  dbOverride?: DB,
) {
  const db = dbOverride ?? (await getDbAsync());
  const conds = [];
  if (f.supplierId) conds.push(eq(schema.processingFeeRefs.supplierId, f.supplierId));
  if (f.q) {
    conds.push(
      or(
        ilike(schema.skus.code, `%${f.q}%`),
        ilike(schema.skus.name, `%${f.q}%`),
        ilike(schema.suppliers.name, `%${f.q}%`),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const base = () =>
    db
      .select({
        id: schema.processingFeeRefs.id,
        skuId: schema.processingFeeRefs.skuId,
        skuCode: schema.skus.code,
        skuName: schema.skus.name,
        supplierId: schema.processingFeeRefs.supplierId,
        supplierName: schema.suppliers.name,
        feeRate: schema.processingFeeRefs.feeRate,
      feeType: schema.processingFeeRefs.feeType,
        effectiveDate: schema.processingFeeRefs.effectiveDate,
        source: schema.processingFeeRefs.source,
        note: schema.processingFeeRefs.note,
      })
      .from(schema.processingFeeRefs)
      .innerJoin(schema.skus, eq(schema.processingFeeRefs.skuId, schema.skus.id))
      .innerJoin(schema.suppliers, eq(schema.processingFeeRefs.supplierId, schema.suppliers.id));

  const [rows, [{ total }]] = await Promise.all([
    base()
      .where(where)
      .orderBy(schema.skus.code, desc(schema.processingFeeRefs.effectiveDate))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.processingFeeRefs)
      .innerJoin(schema.skus, eq(schema.processingFeeRefs.skuId, schema.skus.id))
      .innerJoin(schema.suppliers, eq(schema.processingFeeRefs.supplierId, schema.suppliers.id))
      .where(where),
  ]);
  return { data: rows, total };
}

export async function createFeeRef(user: { id: number }, input: unknown, dbOverride?: DB) {
  const v = createSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  const [sku] = await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.id, v.skuId));
  if (!sku) throw new ApiError(400, "SKU 不存在");
  const [sup] = await db.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.id, v.supplierId));
  if (!sup) throw new ApiError(400, "供应商不存在");
  const [created] = await db
    .insert(schema.processingFeeRefs)
    .values({
      feeType: v.feeType,
      skuId: v.skuId,
      supplierId: v.supplierId,
      feeRate: normFee(v.feeRate ?? null),
      effectiveDate: v.effectiveDate,
      source: "manual",
      note: v.note ?? null,
    })
    .returning();
  await writeAudit(db, {
    userId: user.id,
    entity: "processing_fee_ref",
    entityId: created.id,
    action: "create",
    after: created,
  });
  return created;
}

/** 仅允许改 feeRate/effectiveDate/note——换 SKU/厂请新建行（保留价格历史） */
export async function updateFeeRef(user: { id: number }, id: number, input: unknown, dbOverride?: DB) {
  const v = updateSchema.parse(input);
  const db = dbOverride ?? (await getDbAsync());
  const [before] = await db.select().from(schema.processingFeeRefs).where(eq(schema.processingFeeRefs.id, id));
  if (!before) throw new ApiError(404, "参考价不存在");
  const [after] = await db
    .update(schema.processingFeeRefs)
    .set({
      ...(v.feeType !== undefined ? { feeType: v.feeType } : {}),
      ...(v.feeRate !== undefined ? { feeRate: normFee(v.feeRate) } : {}),
      ...(v.effectiveDate !== undefined ? { effectiveDate: v.effectiveDate } : {}),
      ...(v.note !== undefined ? { note: v.note } : {}),
    })
    .where(eq(schema.processingFeeRefs.id, id))
    .returning();
  await writeAudit(db, {
    userId: user.id,
    entity: "processing_fee_ref",
    entityId: id,
    action: "update",
    before,
    after,
  });
  return after;
}

/** 路由写守卫：采购/admin；回查 DB 新鲜身份 */
export async function guardFeeRefWrite(): Promise<{ id: number; name: string; roles: string[] }> {
  let user: { id: number; name: string; roles: string[] };
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    user = await getFreshSessionUser();
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
  try {
    requireRole(user, "purchasing");
  } catch {
    throw new ApiError(403, "无权限：需要采购角色");
  }
  return user;
}
