/**
 * D57 库存预警阈值（纯函数，唯一权威）。
 *
 * alertDays = 加工周期 + 在途周期 + 缓冲：
 * - 加工周期：sku_params.normal_lead_days；缺省时若有 purchase_lead_days（外购件）则用之；再缺省用
 *   sys_params.default_production_lead_days（默认 30）。
 * - 在途周期：sku_params.logistics_lead_days；缺省用 default_logistics_lead_days（默认 15）。
 * - 缓冲：alert_buffer_days（默认 5）。
 * basis 逐段记录取值与来源，行上可标"按默认周期"（basis 里任一 source==='default'）。
 * 缺省判定：null/undefined/非有限数/负数视为缺省；0 是合法的显式值（本地在途 0 天）。
 *
 * coverStatus 三色：可销天数 < alertDays → alert（红）；≤ targetDays → watch（黄，未越界但已到目标线）；
 * 其余 ok（绿）。可销天数为 null（无销速，理论上无限可销）→ ok，不制造噪音。
 */

export type LeadPart = "production" | "logistics" | "buffer";
export type LeadSource = "sku_params" | "default" | "param";

export interface AlertDaysInput {
  normalLeadDays?: number | null;
  logisticsLeadDays?: number | null;
  purchaseLeadDays?: number | null;
  defaults: { production: number; logistics: number };
  bufferDays: number;
}

export interface LeadBasis {
  part: LeadPart;
  value: number;
  source: LeadSource;
  /** 取自 sku_params 时的字段名，便于行上解释 */
  field: "normal_lead_days" | "purchase_lead_days" | "logistics_lead_days" | null;
}

export interface AlertDaysResult {
  days: number;
  basis: LeadBasis[];
  /** 任一段落到全局缺省 */
  usedDefault: boolean;
}

function present(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function nonNeg(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function alertDays(input: AlertDaysInput): AlertDaysResult {
  const basis: LeadBasis[] = [];
  if (present(input.normalLeadDays)) {
    basis.push({ part: "production", value: input.normalLeadDays, source: "sku_params", field: "normal_lead_days" });
  } else if (present(input.purchaseLeadDays)) {
    basis.push({ part: "production", value: input.purchaseLeadDays, source: "sku_params", field: "purchase_lead_days" });
  } else {
    basis.push({ part: "production", value: nonNeg(input.defaults.production), source: "default", field: null });
  }
  if (present(input.logisticsLeadDays)) {
    basis.push({ part: "logistics", value: input.logisticsLeadDays, source: "sku_params", field: "logistics_lead_days" });
  } else {
    basis.push({ part: "logistics", value: nonNeg(input.defaults.logistics), source: "default", field: null });
  }
  basis.push({ part: "buffer", value: nonNeg(input.bufferDays), source: "param", field: null });
  const days = basis.reduce((acc, b) => acc + b.value, 0);
  return { days, basis, usedDefault: basis.some((b) => b.source === "default") };
}

export type CoverStatus = "alert" | "watch" | "ok";

/**
 * @param onHandDays 在库可销天数；null = 无销速（不预警）；Infinity 同 null
 * @param alertDaysValue 预警阈值天数（红线）
 * @param targetDays 目标覆盖天数（黄线）；null/≤alertDays 时无黄区
 */
export function coverStatus(onHandDays: number | null, alertDaysValue: number, targetDays: number | null): CoverStatus {
  if (onHandDays == null || !Number.isFinite(onHandDays)) return "ok";
  if (onHandDays < alertDaysValue) return "alert";
  if (targetDays != null && Number.isFinite(targetDays) && onHandDays <= targetDays) return "watch";
  return "ok";
}
