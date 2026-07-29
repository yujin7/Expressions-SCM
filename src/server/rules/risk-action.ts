/**
 * F 项：风险库存处置动作判定（纯函数，报表层）。
 *
 * 三源信号（spec/13 §三 F）：批次效期（batch_stocks）× 货盘处置注记（transit_refs
 * kind=pallet exception，R14 备注字典唯一数据源）× 销速（近3月日均）。
 * 输出单一建议动作，优先级自上而下（先命中先生效）：
 * 1. 报废评审   —— 注记含「报废」，或已有批次过期（daysLeft≤0）
 * 2. 禁售隔离   —— 注记含「禁售」（临期禁售等，业务已明令）
 * 3. 商务处置   —— 注记含「商务」（商务库存走专项去化）
 * 4. 促销清库   —— SKU 临期阈值内到期 且（滞销或无动销）——正常销速消化不完
 * 5. 优先出库   —— SKU 临期阈值内到期但销速尚可——先进先出加急即可
 * 6. 滞销关注   —— 无效期风险但滞销（cover>阈值 或 有库存无动销）
 * 7. null（正常）—— 无信号，不进工作台
 *
 * 注记关键词判定宽松（contains），未识别注记不参与判定但原文透传 UI。
 */

export type RiskAction = "报废评审" | "禁售隔离" | "商务处置" | "促销清库" | "优先出库" | "滞销关注";

export interface RiskSignal {
  /** 命中批次最短剩余天数（可为负=已过期）；无效期批次 = null */
  minDaysLeft: number | null;
  /** 可销天数（onHand/daily）；无动销 = null */
  cover: number | null;
  /** 在库量（>0 才可能进工作台） */
  onHand: number;
  /** 滞销阈值（天，slow_days_threshold 运行参数） */
  slowThreshold: number;
  /** 逐 SKU 临期阈值（skus.nearExpiryDays；未维护时由调用方传 90 天兜底） */
  nearExpiryDays: number;
  /** 货盘处置注记原文（无 = null） */
  palletRemark: string | null;
  /** false 时保留效期/注记动作，但不因无动销或高覆盖制造销售型动作。 */
  includeSlowMover?: boolean;
}

/** 滞销判定：有库存但无动销，或可销天数超过阈值 */
export function isSlowMover(s: Pick<RiskSignal, "cover" | "onHand" | "slowThreshold">): boolean {
  if (s.onHand <= 0) return false;
  if (s.cover == null) return true;
  return s.cover > s.slowThreshold;
}

export function suggestRiskAction(s: RiskSignal): RiskAction | null {
  if (s.onHand <= 0 && !s.palletRemark) return null;
  const remark = s.palletRemark ?? "";
  if (remark.includes("报废") || (s.minDaysLeft != null && s.minDaysLeft <= 0)) return "报废评审";
  if (remark.includes("禁售")) return "禁售隔离";
  if (remark.includes("商务")) return "商务处置";
  const slow = s.includeSlowMover !== false && isSlowMover(s);
  if (s.minDaysLeft != null && s.minDaysLeft <= s.nearExpiryDays) return slow ? "促销清库" : "优先出库";
  if (slow) return "滞销关注";
  return null;
}

/** 工作台排序权重（越小越靠前） */
export const RISK_ACTION_ORDER: Record<RiskAction, number> = {
  报废评审: 0,
  禁售隔离: 1,
  商务处置: 2,
  促销清库: 3,
  优先出库: 4,
  滞销关注: 5,
};
