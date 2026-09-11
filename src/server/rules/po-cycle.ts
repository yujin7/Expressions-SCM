/**
 * D63 采购订单周期（纯函数，唯一权威）。
 *
 * - 已下单时点 = PO 审批通过（orderedAt）；
 * - firstDays = 审批 → 首批 SH 收货（日历天，Asia/Shanghai 日界）；
 * - fullDays = 审批 → 全部收货完成；
 * - promiseDeviationDays = 首批收货日 − 承诺交期（正数=迟于承诺）；
 * 缺项一律 null，不猜。
 */

import { dayDiff as businessDayDiff, shanghaiDay, type DateLike } from "@/server/core/business-day";

/**
 * 日界换算的实现在 `core/business-day`（零依赖纯模块，唯一权威）；这里按既有导入路径转出，
 * 调用方（purchase-order-metrics / supplier-payment-term / tests）不必改。
 */
export { shanghaiDay, type DateLike };

function dayDiff(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return businessDayDiff(from, to);
}

export interface PoCycleInput {
  orderedAt: DateLike;
  firstReceiptAt: DateLike;
  completedAt: DateLike;
  promisedDate: DateLike;
}

export interface PoCycleResult {
  firstDays: number | null;
  fullDays: number | null;
  /** 首批收货 − 承诺交期；正=迟到 */
  promiseDeviationDays: number | null;
}

export function orderToDeliveryDays(input: PoCycleInput): PoCycleResult {
  const ordered = shanghaiDay(input.orderedAt);
  const first = shanghaiDay(input.firstReceiptAt);
  const completed = shanghaiDay(input.completedAt);
  const promised = shanghaiDay(input.promisedDate);
  return {
    firstDays: dayDiff(ordered, first),
    fullDays: dayDiff(ordered, completed),
    promiseDeviationDays: dayDiff(promised, first),
  };
}
