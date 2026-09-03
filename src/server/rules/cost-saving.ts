/**
 * D63 采购降本（纯函数，唯一权威）。
 *
 * 降本额 = Σ(基线单价 − 当前单价) × 当年已批数量，**只计降价**；涨价另列 increase，不轧差。
 * 基线 = 上一年度已批 PO 数量加权未税均价（无则首个）——基线由调用方算好传入；缺基线 → 不可比。
 * 金额 scale 2；decimal 字符串。
 */
import { type Dec, dCmp, dMul, dNeg, dSub } from "@/server/core/decimal";

export interface CostSavingInput {
  baselineUnitPrice: Dec | null | undefined;
  currentUnitPrice: Dec | null | undefined;
  qty: Dec;
}

export interface CostSavingResult {
  /** 降价节省（≥0，scale 2） */
  saving: string;
  /** 涨价增支（≥0，scale 2） */
  increase: string;
  /** 单价差 基线 − 当前（scale 4）；不可比 → null */
  unitDiff: string | null;
  comparable: boolean;
}

export function costSaving(input: CostSavingInput): CostSavingResult {
  if (input.baselineUnitPrice == null || input.currentUnitPrice == null) {
    return { saving: "0.00", increase: "0.00", unitDiff: null, comparable: false };
  }
  const unitDiff = dSub(input.baselineUnitPrice, input.currentUnitPrice, 4);
  const qty = dCmp(input.qty, 0) > 0 ? input.qty : 0;
  const total = dMul(unitDiff, qty, 2);
  if (dCmp(total, 0) >= 0) return { saving: total, increase: "0.00", unitDiff, comparable: true };
  return { saving: "0.00", increase: dNeg(total, 2), unitDiff, comparable: true };
}
