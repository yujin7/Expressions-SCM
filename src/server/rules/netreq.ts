/**
 * R11 净需求建议（《01》§5）：
 *   建议量 = 毛需求 − 可用库存 − 在途；≤0 则为 0
 *   再按 MOQ 起订量取下限、按订货倍数向上取整；三数并示由采购确认。
 * 数量 scale=4；纯函数，全部经 decimal.ts。
 */
import { dSub, dCmp, dMax, dCeilToMultiple, dQty } from "@/server/core/decimal";

export interface SuggestQtyInput {
  /** 毛需求 */
  grossReq: string;
  /** 可用库存 */
  onHand: string;
  /** 在途量（PO 实物行未收量） */
  inTransit: string;
  /** 最小起订量（可空） */
  moq?: string | null;
  /** 订货倍数（可空） */
  orderMultiple?: string | null;
}

/** 净需求建议量（qty scale=4） */
export function suggestQty(i: SuggestQtyInput): string {
  let net = dSub(dSub(i.grossReq, i.onHand, 6), i.inTransit, 6);
  if (dCmp(net, "0") <= 0) return "0.0000";
  if (i.moq != null) {
    net = dMax(net, i.moq, 6);
  }
  if (i.orderMultiple != null) {
    net = dCeilToMultiple(net, i.orderMultiple, 6);
  }
  return dQty(net);
}
