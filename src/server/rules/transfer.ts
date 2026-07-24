/**
 * E3-04 仓间调拨建议——纯规则（贪心分配，无 IO）。
 *
 * 原则：multi-echelon rebalancing「先挪自己的货，再花钱买新的」。
 * 全网总量看着没问题时，货可能压在 A 仓、B 仓已断货——本函数把 A 的富余摊给最急的 B。
 *
 * 输入口径（由 modules/report/transfer-suggest.ts 装配，此处不查库）：
 * - surplus/deficit 均为**同一 SKU** 的逐仓视图：onHand=该仓在库，daily=该仓日均出库（近 N 天出库 ÷ N）；
 * - targetDays=补货目标覆盖天数（cover_target_days），alertDays=断货预警阈值（cover_alert_days）。
 *
 * 分配规则：
 * - 盈余仓可让出量 = onHand − daily×alertDays（保留自身 alertDays 的缓冲），下限 0；
 *   daily=0 的呆滞仓保留量为 0，可整仓让出。
 * - 缺口仓所需量 = daily×targetDays − onHand，下限 0。
 * - 缺口仓按可销天数升序（最急先补）、盈余仓按可让出量降序（先掏大仓，少开单据）；
 *   逐对分配至缺口满足或盈余耗尽；qty 向下取整（不拆最小包装）且 >0 才产出。
 */

export interface TransferNode {
  warehouseId: number;
  /** 该仓在库（基础单位） */
  onHand: number;
  /** 该仓日均出库（近 N 天出库合计 ÷ N） */
  daily: number;
}

export interface PlanTransfersInput {
  surplus: TransferNode[];
  deficit: TransferNode[];
  /** 补货目标覆盖天数（cover_target_days） */
  targetDays: number;
  /** 断货预警阈值（cover_alert_days）——同时用作盈余仓的自留缓冲天数 */
  alertDays: number;
}

export interface TransferLine {
  fromWarehouseId: number;
  toWarehouseId: number;
  qty: number;
}

/** 可销天数：daily=0 视为无穷（呆滞，不参与紧迫度排序的有限比较） */
function coverOf(n: TransferNode): number {
  return n.daily > 0 ? n.onHand / n.daily : Number.POSITIVE_INFINITY;
}

export function planTransfers(input: PlanTransfersInput): TransferLine[] {
  const targetDays = Math.max(0, input.targetDays);
  const alertDays = Math.max(0, input.alertDays);

  // 盈余侧：可让出量 = 在库 − 自留缓冲（daily×alertDays），下限 0
  const pool = (input.surplus ?? [])
    .map((s) => ({ warehouseId: s.warehouseId, avail: Math.max(0, s.onHand - s.daily * alertDays) }))
    .filter((s) => s.avail > 0)
    .sort((a, b) => b.avail - a.avail || a.warehouseId - b.warehouseId);

  // 缺口侧：补到目标覆盖所需量；按可销天数升序（最急先补）
  const needs = (input.deficit ?? [])
    .map((d) => ({ warehouseId: d.warehouseId, need: Math.max(0, d.daily * targetDays - d.onHand), cover: coverOf(d) }))
    .filter((d) => d.need > 0)
    .sort((a, b) => a.cover - b.cover || b.need - a.need || a.warehouseId - b.warehouseId);

  const lines: TransferLine[] = [];
  for (const d of needs) {
    let remain = d.need;
    for (const s of pool) {
      if (remain <= 0) break;
      if (s.avail <= 0) continue;
      if (s.warehouseId === d.warehouseId) continue; // 防御：同仓不自调
      const qty = Math.floor(Math.min(s.avail, remain));
      if (qty <= 0) continue; // 不足 1 个基础单位不产出
      lines.push({ fromWarehouseId: s.warehouseId, toWarehouseId: d.warehouseId, qty });
      s.avail -= qty;
      remain -= qty;
    }
  }
  return lines;
}
