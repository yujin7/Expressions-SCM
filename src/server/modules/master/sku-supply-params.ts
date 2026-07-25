/**
 * struct#5：SKU 供应参数唯一读facade——终结 MOQ/生产周期/成本/临期阈值散在 4 张表、
 * 各调用方各自 join 的乱象。一次读齐，调用方拿单一形状。
 *
 * 权威表（不物理合并，避免破坏 uom_convs 的 MOQ 权威等既有约束）：
 * - MOQ/订货倍数 ← uom_convs，**换算成基础单位后返回**（见下）
 * - 常规/紧急生产周期 ← sku_params
 * - 单位成本 ← sku_costs（手工 v1）
 * - 临期阈值 ← skus.nearExpiryDays
 *
 * ── MOQ 的单位（容易错，写清楚）──
 * `uom_convs` 一行 = 一个采购单位，`factor` 的定义是「1 采购单位 = factor 基础单位」，
 * 因此 `moq`/`order_multiple` 都是**以该采购单位计**的。而下游 `rules/netreq` 把它们
 * 直接和毛需求/在库/在途比较——那些全是**基础单位**。
 * 所以这里必须乘 `factor` 换算后再给出去；否则「起订 10 箱（1箱=24支）」会被当成
 * 「起订 10 支」，建议量少一个数量级。
 * 真实数据里放行引擎建的行都是 `purchaseUom=基础单位, factor=1`，换算前后数值相同，
 * 这是**修潜在缺陷、不是改现有数字**；但 seed 与人工维护的多采购单位行会踩到。
 *
 * 多行时的取舍：优先取 factor=1（基础单位）那行——最不意外；否则按 id 取最小，
 * 并置 `moqAmbiguous=true` 把「这个 SKU 有多个采购单位、系统替你挑了一个」显性化，
 * 而不是像以前那样静默取首行。挑哪个采购单位属采购策略，系统不擅自替业务裁决。
 */
import { asc, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { dCmp, dMul, dQty } from "@/server/core/decimal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface SkuSupplyParams {
  /** 最小起订量，**已换算为基础单位** */
  moq: string | null;
  /** 订货倍数，**已换算为基础单位** */
  orderMultiple: string | null;
  /** MOQ 取自哪个采购单位（供 UI 说明来源）；无 uom_convs 行 = null */
  moqSourceUom: string | null;
  /** 该 SKU 有多个采购单位、系统替你挑了一个——需人工确认采购口径 */
  moqAmbiguous: boolean;
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
    if (!v) { v = { moq: null, orderMultiple: null, moqSourceUom: null, moqAmbiguous: false, normalLeadDays: null, urgentLeadDays: null, unitCost: null, nearExpiryDays: null }; out.set(id, v); }
    return v;
  };

  const [uomRows, spRows, costRows, skuRows] = await Promise.all([
    db.select({ skuId: schema.uomConvs.skuId, purchaseUom: schema.uomConvs.purchaseUom, factor: schema.uomConvs.factor, moq: schema.uomConvs.moq, orderMultiple: schema.uomConvs.orderMultiple }).from(schema.uomConvs).where(inArray(schema.uomConvs.skuId, skuIds)).orderBy(asc(schema.uomConvs.id)),
    db.select({ skuId: schema.skuParams.skuId, normalLeadDays: schema.skuParams.normalLeadDays, urgentLeadDays: schema.skuParams.urgentLeadDays }).from(schema.skuParams).where(inArray(schema.skuParams.skuId, skuIds)),
    db.select({ skuId: schema.skuCosts.skuId, unitCost: schema.skuCosts.unitCost }).from(schema.skuCosts).where(inArray(schema.skuCosts.skuId, skuIds)),
    db.select({ id: schema.skus.id, nearExpiryDays: schema.skus.nearExpiryDays }).from(schema.skus).where(inArray(schema.skus.id, skuIds)),
  ]);
  type UomRow = { skuId: number; purchaseUom: string; factor: string | null; moq: string | null; orderMultiple: string | null };
  const rowsBySku = new Map<number, UomRow[]>();
  for (const r of uomRows as UomRow[]) {
    const arr = rowsBySku.get(r.skuId);
    if (arr) arr.push(r); else rowsBySku.set(r.skuId, [r]);
  }
  const isBase = (r: UomRow) => dCmp(r.factor ?? "1", "1") === 0;
  for (const [skuId, rows] of rowsBySku) {
    // 优先基础单位行；否则按 id 最小（rows 已按 id 升序）
    const pick = rows.find(isBase) ?? rows[0];
    const factor = pick.factor ?? "1";
    const v = ensure(skuId);
    // 换算到基础单位：MOQ 以采购单位计，下游按基础单位比较
    v.moq = pick.moq == null ? null : dQty(dMul(pick.moq, factor, 6));
    v.orderMultiple = pick.orderMultiple == null ? null : dQty(dMul(pick.orderMultiple, factor, 6));
    v.moqSourceUom = pick.purchaseUom;
    v.moqAmbiguous = rows.length > 1;
  }
  for (const r of spRows as { skuId: number; normalLeadDays: number | null; urgentLeadDays: number | null }[]) {
    const v = ensure(r.skuId); v.normalLeadDays = r.normalLeadDays; v.urgentLeadDays = r.urgentLeadDays;
  }
  for (const r of costRows as { skuId: number; unitCost: string | null }[]) { ensure(r.skuId).unitCost = r.unitCost; }
  for (const r of skuRows as { id: number; nearExpiryDays: number | null }[]) { ensure(r.id).nearExpiryDays = r.nearExpiryDays; }
  return out;
}
