/**
 * R1 价格异动（《00》A5 终版）：
 * - 比价口径统一为「基础单位 + 未税」：price ÷ (1+税率) ÷ 单位换算系数
 * - 首购（无基准价）免检，不触发 PC
 * - 偏差 = (新价−基准价)/基准价×100（scale=2）；|偏差| > 容差 → 需走 PC 价格变更
 * 纯函数，无副作用；全部经 decimal.ts 定点运算。
 */
import { dAdd, dCmp, dDiv, dMoney, dNeg, dDeviationPct } from "@/server/core/decimal";

export interface NormalizeInput {
  /** 报价（可能含税、可能按采购单位） */
  price: string;
  /** 报价是否含税 */
  taxIncluded: boolean;
  /** 税率百分数，如 "13" */
  taxRatePct: string;
  /** 采购单位换算系数：1 采购单位 = uomFactor 基础单位 */
  uomFactor: string;
}

/** 归一化为「基础单位未税价」（金额 scale=2） */
export function normalizeToBaseNet(i: NormalizeInput): string {
  // 中间计算 scale=6，最后落金额口径
  let net = i.price;
  if (i.taxIncluded) {
    const taxFactor = dAdd("1", dDiv(i.taxRatePct, "100", 6), 6);
    net = dDiv(net, taxFactor, 6);
  }
  return dMoney(dDiv(net, i.uomFactor, 6));
}

export interface DeviationInput {
  /** 基准价（基础单位未税）；null = 首购 */
  baselineBaseNet: string | null;
  /** 新价（基础单位未税） */
  newBaseNet: string;
  /** 容差百分数（sys_param price_tolerance_pct，默认 3） */
  tolerancePct: string;
}

export interface DeviationResult {
  /** 偏差百分比（scale=2）；首购为 null */
  deviationPct: string | null;
  /** 是否超容差、需 PC 价格变更审批 */
  requiresPc: boolean;
}

/** 价格偏差检查：首购免检；|偏差| > 容差 → 需 PC */
export function checkPriceDeviation(i: DeviationInput): DeviationResult {
  if (i.baselineBaseNet === null) {
    return { deviationPct: null, requiresPc: false };
  }
  const deviationPct = dDeviationPct(i.baselineBaseNet, i.newBaseNet);
  const absDeviation = dCmp(deviationPct, "0") < 0 ? dNeg(deviationPct, 2) : deviationPct;
  return { deviationPct, requiresPc: dCmp(absDeviation, i.tolerancePct) > 0 };
}
