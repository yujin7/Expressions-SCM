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
 *
 * 学习交期（审计 #6，**只观察不生效**）：alertDays 可选传入 rollup_supplier_lead 的 {p50,p90,samples,onTimeRate}；
 * 样本 ≥ 3 且 P90 比档案加工周期高出超过容差（sys_param alert_learned_lead_tolerance_days）时，
 * basis 追加一条 {part:'learned', source:'learned', value:delta, observeOnly:true}——**不计入 days**，
 * 行上显示为「学习修正 +6(P90, n=12, 观察)」，一个周期后再决定是否生效。
 *
 * coverStatusWithSupply（审计 #1）：在库口径 alert 但在库 > 0 且有**确认到货日**落在阈值天数内的记账层/参考层供给，
 * 降为 watch 并给出 basis 文案；在库 = 0 是物理事实，不因在途降级（out_of_stock 由调用方单独判定）。
 */

import { dSub } from "@/server/core/decimal";

export type LeadPart = "production" | "logistics" | "buffer" | "learned";
export type LeadSource = "sku_params" | "default" | "param" | "learned";

/** rollup_supplier_lead 物化的学习交期（供应商 × SKU）；调用方挑样本最多的一行 */
export interface LearnedLead {
  p50: number | null;
  p90: number | null;
  samples: number;
  onTimeRate: number | null;
}

export interface AlertDaysInput {
  normalLeadDays?: number | null;
  logisticsLeadDays?: number | null;
  purchaseLeadDays?: number | null;
  defaults: { production: number; logistics: number };
  bufferDays: number;
  /** 学习交期（可选）；null/缺省 = 无物化结果 */
  learned?: LearnedLead | null;
  /** P90 超出档案值多少天才记观察项（缺省 3）；负数按 0 */
  learnedToleranceDays?: number;
  /** 观察项最少样本数（缺省 3） */
  learnedMinSamples?: number;
}

export interface LeadBasis {
  part: LeadPart;
  value: number;
  source: LeadSource;
  /** 取自 sku_params 时的字段名，便于行上解释 */
  field: "normal_lead_days" | "purchase_lead_days" | "logistics_lead_days" | null;
  /** true = 只观察不计入 days（学习交期第一周期） */
  observeOnly?: boolean;
}

export interface LearnedLeadObservation {
  /** 档案加工周期（比较基准） */
  archiveDays: number;
  p50: number | null;
  p90: number;
  samples: number;
  onTimeRate: number | null;
  /** P90 − 档案值（正数才记录） */
  delta: number;
  toleranceDays: number;
  /** 恒 true：本周期只观察，阈值未变 */
  observeOnly: true;
  applied: false;
}

export interface AlertDaysResult {
  days: number;
  basis: LeadBasis[];
  /** 任一段落到全局缺省 */
  usedDefault: boolean;
  /** 学习交期观察项；未触发/无数据 = null */
  learned: LearnedLeadObservation | null;
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

  // 学习交期：只观察不生效（阈值不变；行上单独显示）
  let learned: LearnedLeadObservation | null = null;
  const l = input.learned;
  const minSamples = Math.max(1, Math.trunc(input.learnedMinSamples ?? 3));
  const tolerance = nonNeg(input.learnedToleranceDays ?? 3);
  if (l && l.samples >= minSamples && present(l.p90)) {
    const archiveDays = basis[0].value;
    const delta = Number(dSub(l.p90, archiveDays, 2));
    if (delta > tolerance) {
      learned = { archiveDays, p50: present(l.p50) ? l.p50 : null, p90: l.p90, samples: l.samples, onTimeRate: l.onTimeRate ?? null, delta, toleranceDays: tolerance, observeOnly: true, applied: false };
      basis.push({ part: "learned", value: delta, source: "learned", field: null, observeOnly: true });
    }
  }
  return { days, basis, usedDefault: basis.some((b) => b.source === "default"), learned };
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

export interface SupplyArrival {
  /** 预计到货日 YYYY-MM-DD */
  date: string;
  qty: number;
  source: string;
  ref: string | null;
}

export interface CoverWithSupplyInput {
  /** 在库口径的三色状态（coverStatus 结果） */
  status: CoverStatus;
  onHand: number;
  /** 最近一笔有确认到货日、且未逾期的供给；无 = null */
  nextArrival: SupplyArrival | null;
  /** 判定日 YYYY-MM-DD */
  today: string;
  alertDaysValue: number;
}

export interface CoverWithSupplyResult {
  status: CoverStatus;
  /** true = 由 alert 降为 watch */
  downgraded: boolean;
  /** 降级依据文案；未降级 = null */
  basis: string | null;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * 在库 alert 且在库 > 0，且下一笔到货日落在 [today, today + alertDays] 内 → 降为 watch。
 * 在库 ≤ 0 不降（物理事实）；到货日逾期（< today）不降（逾期在途不是可信供给）。
 */
export function coverStatusWithSupply(input: CoverWithSupplyInput): CoverWithSupplyResult {
  const keep: CoverWithSupplyResult = { status: input.status, downgraded: false, basis: null };
  if (input.status !== "alert") return keep;
  if (!(input.onHand > 0)) return keep;
  const a = input.nextArrival;
  if (!a || !/^\d{4}-\d{2}-\d{2}$/.test(a.date) || !(a.qty > 0)) return keep;
  const inDays = daysBetween(input.today, a.date);
  if (!Number.isFinite(inDays) || inDays < 0 || inDays > input.alertDaysValue) return keep;
  return {
    status: "watch",
    downgraded: true,
    basis: `在途 ${a.source}${a.ref ? ` ${a.ref}` : ""} ${a.qty} 件预计 ${a.date} 到（${inDays} 天内 ≤ 阈值 ${input.alertDaysValue} 天），低于阈值降为关注；在库可销仍按在库口径显示`,
  };
}
