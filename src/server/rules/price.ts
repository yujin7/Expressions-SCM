/**
 * R1 价格异动（《00》A5 终版）：
 * - 比价口径统一为「基础单位 + 未税」：price ÷ (1+税率) ÷ 单位换算系数
 * - 首购（无基准价）免检，不触发 PC
 * - 偏差 = (新价−基准价)/基准价×100（scale=2）；|偏差| > 容差 → 需走 PC 价格变更
 * 纯函数，无副作用；全部经 decimal.ts 定点运算。
 */
import { dAdd, dCmp, dDiv, dMoney, dMul, dNeg, dZero, dDeviationPct } from "@/server/core/decimal";

/** 价格规则业务异常（红队 m3：以可识别错误替代裸 division by zero） */
export class PriceRuleError extends Error {
  constructor(
    public readonly code: "UOM_FACTOR_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "PriceRuleError";
  }
}

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
  if (dZero(i.uomFactor) || dCmp(i.uomFactor, "0") < 0) {
    throw new PriceRuleError("UOM_FACTOR_INVALID", `单位换算系数非法：${i.uomFactor}（须大于 0）`);
  }
  // 中间计算 scale=6，最后落金额口径
  let net = i.price;
  if (i.taxIncluded) {
    const taxFactor = dAdd("1", dDiv(i.taxRatePct, "100", 6), 6);
    net = dDiv(net, taxFactor, 6);
  }
  return dMoney(dDiv(net, i.uomFactor, 6));
}

export interface LineNetGrossInput {
  /** 行单价（采购单位；含税与否见 taxIncluded） */
  price: string;
  /** 行数量（采购单位） */
  qty: string;
  taxIncluded: boolean;
  /** 税率百分数，如 "13" */
  taxRatePct: string;
}

export interface LineNetGross {
  /** 行未税金额（scale=2） */
  net: string;
  /** 行含税金额（scale=2） */
  gross: string;
}

/**
 * 单据行「未税 / 含税」并列金额（D63/D64 采购订单口径唯一实现）：
 * 行金额 = price × qty（中间 scale=6）；含税报价 → 去税求未税，未税报价 → 补税求含税；税率取行上 taxRatePct。
 */
export function normalizeLineNetGross(i: LineNetGrossInput): LineNetGross {
  const amount = dMul(i.price, i.qty, 6);
  const taxFactor = dAdd("1", dDiv(i.taxRatePct, "100", 6), 6);
  if (i.taxIncluded) return { net: dDiv(amount, taxFactor, 2), gross: dMoney(amount) };
  return { net: dMoney(amount), gross: dMul(amount, taxFactor, 2) };
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

/** 价格偏差检查：首购免检；基准价=0 视为数据异常强制 PC（红队 M2：不再抛除零错）；|偏差| > 容差 → 需 PC */
export function checkPriceDeviation(i: DeviationInput): DeviationResult {
  if (i.baselineBaseNet === null) {
    return { deviationPct: null, requiresPc: false };
  }
  if (dZero(i.baselineBaseNet)) {
    // 基准价为 0 无法计算偏差比：按数据异常处理，强制走价格变更审批复核
    return { deviationPct: null, requiresPc: true };
  }
  const deviationPct = dDeviationPct(i.baselineBaseNet, i.newBaseNet);
  const absDeviation = dCmp(deviationPct, "0") < 0 ? dNeg(deviationPct, 2) : deviationPct;
  return { deviationPct, requiresPc: dCmp(absDeviation, i.tolerancePct) > 0 };
}
