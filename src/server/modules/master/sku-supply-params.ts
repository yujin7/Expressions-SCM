/**
 * struct#5：SKU 供应参数唯一读facade——终结 MOQ/生产周期/成本/临期阈值散在 4 张表、
 * 各调用方各自 join 的乱象。一次读齐，调用方拿单一形状。
 *
 * 权威表（不物理合并，避免破坏 uom_convs 的 MOQ 权威等既有约束）：
 * - MOQ/订货倍数 ← uom_convs（首行按 id）
 * - 常规/紧急生产周期 ← sku_params
 * - 单位成本 ← sku_costs（手工 v1）
 * - 临期阈值 ← skus.nearExpiryDays
 */
import { asc, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface SkuSupplyParams {
  moq: string | null;
  orderMultiple: string | null;
  normalLeadDays: number | null;
  urgentLeadDays: number | null;
  unitCost: string | null;
  nearExpiryDays: number | null;
}

export async function getSkuSupplyParams(skuIds: number[], dbArg?: AnyDb): Promise<Map<number, SkuSupplyParams>> {
  const out = new Map<number, SkuSupplyParams>();
  if (skuIds.length === 0) return out;
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const ensure = (id: number): SkuSupplyParams => {
    let v = out.get(id);
    if (!v) { v = { moq: null, orderMultiple: null, normalLeadDays: null, urgentLeadDays: null, unitCost: null, nearExpiryDays: null }; out.set(id, v); }
    return v;
  };

  const [uomRows, spRows, costRows, skuRows] = await Promise.all([
    db.select({ skuId: schema.uomConvs.skuId, moq: schema.uomConvs.moq, orderMultiple: schema.uomConvs.orderMultiple }).from(schema.uomConvs).where(inArray(schema.uomConvs.skuId, skuIds)).orderBy(asc(schema.uomConvs.id)),
    db.select({ skuId: schema.skuParams.skuId, normalLeadDays: schema.skuParams.normalLeadDays, urgentLeadDays: schema.skuParams.urgentLeadDays }).from(schema.skuParams).where(inArray(schema.skuParams.skuId, skuIds)),
    db.select({ skuId: schema.skuCosts.skuId, unitCost: schema.skuCosts.unitCost }).from(schema.skuCosts).where(inArray(schema.skuCosts.skuId, skuIds)),
    db.select({ id: schema.skus.id, nearExpiryDays: schema.skus.nearExpiryDays }).from(schema.skus).where(inArray(schema.skus.id, skuIds)),
  ]);
  const seenUom = new Set<number>();
  for (const r of uomRows as { skuId: number; moq: string | null; orderMultiple: string | null }[]) {
    if (seenUom.has(r.skuId)) continue; // 首行按 id
    seenUom.add(r.skuId);
    const v = ensure(r.skuId); v.moq = r.moq; v.orderMultiple = r.orderMultiple;
  }
  for (const r of spRows as { skuId: number; normalLeadDays: number | null; urgentLeadDays: number | null }[]) {
    const v = ensure(r.skuId); v.normalLeadDays = r.normalLeadDays; v.urgentLeadDays = r.urgentLeadDays;
  }
  for (const r of costRows as { skuId: number; unitCost: string | null }[]) { ensure(r.skuId).unitCost = r.unitCost; }
  for (const r of skuRows as { id: number; nearExpiryDays: number | null }[]) { ensure(r.id).nearExpiryDays = r.nearExpiryDays; }
  return out;
}
