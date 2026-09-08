import { dAdd, dCmp, dDiv, dMul, dQty, dSub } from "@/server/core/decimal";
import { shanghaiDay } from "@/server/core/business-day";

export interface CapacityDeclaration {
  declaredMonthlyCapacity: string | null;
  capacityUom: string | null;
  surgeCapacityPct: number | null;
  capacityValidFrom: string | null;
  capacityValidUntil: string | null;
  capacityEvidence: string | null;
}

export interface DeclaredCapacityComparison extends CapacityDeclaration {
  basis: "supplier_declared_monthly_scenario";
  state: "missing" | "unqualified" | "unit_mismatch" | "outside_validity" | "missing_due_date" | "incomplete_schedule" | "comparable";
  reason: string;
  targetMonth: string | null;
  asOfDay: string;
  projectedQty: string;
  baseUom: string;
  normalLimitQty: string | null;
  surgeLimitQty: string | null;
  normalHeadroomQty: string | null;
  surgeHeadroomQty: string | null;
  normalLoadPct: string | null;
  overNormal: boolean | null;
  overSurge: boolean | null;
}

/** A dated supplier statement is a scenario, never an allocation or promise to this company. */
export function compareDeclaredCapacity(
  declaration: CapacityDeclaration,
  context: { baseUom: string; dueDate: string | null; asOfDay: string; projectedQty: string; undatedOrders: number },
): DeclaredCapacityComparison {
  const targetMonth = context.dueDate && shanghaiDay(context.dueDate) != null ? context.dueDate.slice(0, 7) : null;
  const result: DeclaredCapacityComparison = {
    ...declaration, basis: "supplier_declared_monthly_scenario", state: "unqualified", reason: "申报缺有效期或依据，待采购核对", targetMonth,
    asOfDay: context.asOfDay, projectedQty: context.projectedQty, baseUom: context.baseUom,
    normalLimitQty: null, surgeLimitQty: null, normalHeadroomQty: null, surgeHeadroomQty: null,
    normalLoadPct: null, overNormal: null, overSurge: null,
  };
  const qty = declaration.declaredMonthlyCapacity;
  if (qty == null) return { ...result, state: "missing", reason: "尚未登记申报月产能" };
  const from = declaration.capacityValidFrom, until = declaration.capacityValidUntil;
  if (!/^\d+(\.\d{1,4})?$/.test(qty) || !from || !until || shanghaiDay(from) == null || shanghaiDay(until) == null || from > until || !declaration.capacityEvidence?.trim()) return result;
  if (!declaration.capacityUom || declaration.capacityUom !== context.baseUom) return { ...result, state: "unit_mismatch", reason: `申报单位 ${declaration.capacityUom || "未填"} 与单据 ${context.baseUom} 不一致，不自动换算` };
  if (!targetMonth) return { ...result, state: "missing_due_date", reason: "单据未有有效交期，无法确定申报比较月份" };
  const [year, month] = targetMonth.split("-").map(Number);
  const monthEnd = `${targetMonth}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  if (shanghaiDay(context.asOfDay) == null || context.asOfDay < from || context.asOfDay > until || from > `${targetMonth}-01` || until < monthEnd) {
    return { ...result, state: "outside_validity", reason: "申报未当前生效、已失效或未覆盖交付整月，不推算月度余量" };
  }
  if (context.undatedOrders > 0) return { ...result, state: "incomplete_schedule", reason: `${context.undatedOrders} 张同单位未结JG缺交期，月度负荷不完整，先补交期` };
  const normal = dQty(qty);
  const pct = declaration.surgeCapacityPct;
  const surge = pct != null && Number.isInteger(pct) && pct >= 0 && pct <= 300
    ? dMul(normal, dAdd("1", dDiv(String(pct), "100", 6), 6), 4) : null;
  return {
    ...result, state: "comparable", reason: "仅将本系统计划量与供应商申报情景比较；不含其他客户占用，不是可承诺余量",
    normalLimitQty: normal, surgeLimitQty: surge,
    normalHeadroomQty: dSub(normal, context.projectedQty, 4),
    surgeHeadroomQty: surge == null ? null : dSub(surge, context.projectedQty, 4),
    normalLoadPct: dCmp(normal, "0") > 0 ? dMul(dDiv(context.projectedQty, normal, 6), "100", 2) : null,
    overNormal: dCmp(context.projectedQty, normal) > 0,
    overSurge: surge == null ? null : dCmp(context.projectedQty, surge) > 0,
  };
}
