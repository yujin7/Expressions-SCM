import { and, arrayContains, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { shanghaiDay } from "@/server/core/business-day";
import { ApiError } from "@/server/modules/master/common";
import { getSupplierCapacitySignal, type SupplierCapacitySignal } from "@/server/modules/report/supplier-capacity";
import { type AnyDb, requireAnyRole, resolveDb } from "./common";
import { SUPPLIER_STATUS_LABELS } from "./sourcing-aid";
import { capacityFingerprint, capacityHandoffOptions } from "./capacity-source";

const id = z.coerce.number().int().positive().max(2_147_483_647);
const querySchema = z.object({
  skuId: id,
  alertId: id.optional(),
  supplierId: id.optional(),
  dueDate: z.string().refine(v => shanghaiDay(v) !== null, "交付日期无效").optional(),
  candidateQty: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, "数量最多10位整数、4位小数")
    .refine(v => /[1-9]/.test(v), "拟新增量必须大于0").optional(),
}).superRefine((v, ctx) => {
  const fields = [v.supplierId, v.dueDate, v.candidateQty];
  if (fields.some(v => v !== undefined) && fields.some(v => v === undefined)) {
    ctx.addIssue({ code: "custom", message: "请选择加工厂，并填写交付日期和拟新增量" });
  }
});

export interface CapacityCheck {
  sku: { id: number; code: string; name: string; baseUom: string };
  factories: { id: number; code: string; name: string; status: string; statusLabel: string; hasApprovedHistory: boolean }[];
  scenario: { supplierId: number; dueDate: string; candidateQty: string; signal: SupplierCapacitySignal } | null;
  handoff?: Awaited<ReturnType<typeof capacityHandoffOptions>>;
  evidenceKey?: string;
}

/** Manual scenario only. No observation-derived quantity, allocation, approval or posting. */
export async function getCapacityCheck(user: SessionUser, raw: unknown, dbArg?: AnyDb): Promise<CapacityCheck> {
  requireAnyRole(user, "purchasing", "pmc", "ops");
  const query = querySchema.parse(raw);
  const db = await resolveDb(dbArg);
  const [sku] = await db.select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name,
    baseUom: schema.skus.baseUom, skuType: schema.skus.skuType }).from(schema.skus).where(eq(schema.skus.id, query.skuId));
  if (!sku) throw new ApiError(404, "SKU不存在");
  if (sku.skuType !== "finished") throw new ApiError(400, "本入口核对成品加工产能；物料采购请使用工单选源参考");
  // Directory, not an approved-source list: first-time factories remain available for human inquiry.
  // Only approved/effective JG relations earn the history label; drafts do not prove cooperation.
  const [directory, history] = await Promise.all([
    db.select({ id: schema.suppliers.id, code: schema.suppliers.code, name: schema.suppliers.name, status: schema.suppliers.status })
      .from(schema.suppliers).where(arrayContains(schema.suppliers.kinds, ["processor"])).orderBy(schema.suppliers.code, schema.suppliers.id),
    db.selectDistinct({ supplierId: schema.jgDocs.supplierId }).from(schema.jgDocs)
      .where(and(eq(schema.jgDocs.productSkuId, sku.id), inArray(schema.jgDocs.status, ["approved", "in_progress", "completed"]))),
  ]);
  const known = new Set(history.map(row => row.supplierId));
  const factories = directory.map(row => ({ ...row, statusLabel: SUPPLIER_STATUS_LABELS[row.status] ?? row.status,
    hasApprovedHistory: known.has(row.id) }));
  if (query.supplierId !== undefined && !factories.some(row => row.id === query.supplierId)) {
    throw new ApiError(400, "所选供应商不是当前加工厂档案，请重新核对");
  }
  const scenario = query.supplierId !== undefined && query.dueDate !== undefined && query.candidateQty !== undefined
    ? { supplierId: query.supplierId, dueDate: query.dueDate, candidateQty: query.candidateQty,
      signal: await getSupplierCapacitySignal({ supplierId: query.supplierId, baseUom: sku.baseUom,
        dueDate: query.dueDate, candidateQty: query.candidateQty }, db) }
    : null;
  const handoff = query.alertId === undefined ? undefined : await capacityHandoffOptions(user, query.alertId, sku.id, db);
  const result: CapacityCheck = { sku: { id: sku.id, code: sku.code, name: sku.name, baseUom: sku.baseUom }, factories, scenario,
    ...(handoff ? { handoff } : {}) };
  if (handoff && scenario) result.evidenceKey = capacityFingerprint({ sku: result.sku,
    factory: factories.find(row => row.id === scenario.supplierId), scenario, source: handoff.source });
  return result;
}
