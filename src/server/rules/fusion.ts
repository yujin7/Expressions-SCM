/**
 * R11+ 全口径供需融合（纯函数，报表/建议层，非记账）。
 *
 * 背景（2026-07-24 总库存核对结论）：系统在库=电商部口径（实时账+电商部快照源），
 * 而「总库存明细」为全公司口径（含海外/其他部门仓）——474 个 SKU 文件>系统，属覆盖缺口。
 * 若补货建议只看系统口径，会对缺口 SKU 建议重复采购已存在的库存（如 E054-000 差 17.6 万）。
 *
 * 本模块提供三个纯判定，供 replenish service 融合参考层：
 * - fuseCover：全管道可销天数 = (有效在库 + PO在途 + 存量在途 + 在订未出) / 日均；
 *   有效在库 = max(系统在库, 全口径参考)——参考只会调高在库认知，绝不调低（参考层不可当账）。
 * - detectRefGap：全口径参考显著高于系统在库（绝对>10 且相对>20%）→ 覆盖缺口 SKU。
 * - shouldSuppressSuggest：系统口径触发建议、但全口径管道充足且属缺口 SKU → 抑制建议
 *   （防重复下单；抑制≠隐藏，UI 必须展示抑制原因，人工可核实后手工开单）。
 *
 * 口径纪律：本文件只做展示层 number 运算（与既有 cover 计算同准），不产出记账数字。
 */

export interface FusionInput {
  /** 系统在库（全网口径 D20，展示层 number） */
  onHand: number;
  /** 全口径参考在库（总库存明细文件；无参考 = null） */
  refQty: number | null;
  /** PO 在途（未收量） */
  inTransit: number;
  /** 存量单在途（transit_refs fg_order 未入库余量，旧流程收尾口径） */
  legacyTransit: number;
  /** 在订未出（总库存明细「已下单未出货」；无参考 = 0） */
  onOrder: number;
  /** 在制委外产出（WO 计划产出；func#1——成品主要补给来源） */
  wip?: number;
  /** 近3月日均销 */
  daily: number;
}

/** 覆盖缺口判定：参考显著高于系统（绝对差 >10 且 相对差 >20%） */
export function detectRefGap(onHand: number, refQty: number | null): boolean {
  if (refQty == null) return false;
  const diff = refQty - onHand;
  return diff > 10 && diff > refQty * 0.2;
}

/** 全管道可销天数（日均=0 → null）；有效在库=max(系统, 参考) */
export function fuseCover(input: FusionInput): number | null {
  if (input.daily <= 0) return null;
  const effectiveOnHand = Math.max(input.onHand, input.refQty ?? input.onHand);
  const pipeline = effectiveOnHand + input.inTransit + input.legacyTransit + input.onOrder + (input.wip ?? 0);
  return pipeline / input.daily;
}

/**
 * 建议抑制：系统口径告急（coverSystem<alert）但该 SKU 属覆盖缺口且全管道口径充足
 * （coverFull≥alert）→ 抑制，防止对海外/其他仓已有库存重复下单。
 */
export function shouldSuppressSuggest(
  coverSystem: number | null,
  coverFull: number | null,
  minCoverAlert: number,
  refGap: boolean,
): boolean {
  if (!refGap || coverSystem == null || coverFull == null) return false;
  return coverSystem < minCoverAlert && coverFull >= minCoverAlert;
}

/** 生产周期风险：可销天数已低于常规生产周期 → 即使未到全局预警阈值，补货窗口也已迫近 */
export function belowLeadtime(cover: number | null, leadDays: number | null): boolean {
  return cover != null && leadDays != null && leadDays > 0 && cover < leadDays;
}
