/**
 * W2-#2 临期净额（纯函数）：在库里**卖不到就会过期**的那部分，不能算作可用库存。
 *
 * 为什么必须有：`core/stock-view.getOnHandBySku` 把临期与已过期批次一并算作在库，
 * 补货引擎据此判「水位够、不用补」，那批货随后过期报废——库存表上一直有数，货架上却断了。
 * 这是结构性缺货，不是参数没调好。
 *
 * 判定（FEFO，先到期先出）：把命中批次按剩余效期升序排列，第 i 批到期前**最多**能卖出
 * `日均 × 剩余天数`（该批之前的批次也只能在同一段时间里卖，故按前缀累计比较）。
 *   卖不掉的量 = max over i of ( Σ_{j≤i} qty_j − 日均 × daysLeft_i )，下限 0。
 * 已过期批次 daysLeft ≤ 0 → 容量 0 → 全额计入（它们已经没有销售窗口了）。
 *
 * 纪律：
 * - 只算「卖不掉」，不算报废损失、不改在库口径——在库数字仍由 core/stock-view 唯一给出；
 * - 剩余效期超出推演视野的批次不参与：它们的容量 `日均 × daysLeft` 必然大于视野内的总消耗，
 *   在上式里永远不是最紧的那一项，纳不纳入结果相同（少读一批行）；
 * - 日均 = 0 时任何批次都卖不掉，但此时引擎本就不产生需求，故整体量仍如实给出、由调用方决定用途；
 * - 展示层 number 运算（与 cover / safetyQty 同准），不产出记账数字。
 */

export interface ExpiryBatch {
  /** 距到期天数（可为负 = 已过期） */
  daysLeft: number;
  qty: number;
}

export interface ExpiryNettingInput {
  batches: ExpiryBatch[];
  /** 日均消耗（≥0） */
  daily: number;
  /** 推演视野（天）；剩余效期超过它的批次不参与判定 */
  horizonDays: number;
}

export interface ExpiryNettingResult {
  /** 视野内无法在效期前售出的量（下限 0） */
  unsellableQty: number;
  /** 其中已过期（daysLeft ≤ 0）的小计 */
  expiredQty: number;
  /** 参与判定的批次合计（视野内的临期+已过期） */
  atRiskQty: number;
  batchesConsidered: number;
  /** 决定 unsellableQty 的那一批的剩余天数；无净额 = null */
  bindingDaysLeft: number | null;
  /** 命中批次的最短剩余天数；无命中 = null */
  minDaysLeft: number | null;
}

export function netExpiringStock(input: ExpiryNettingInput): ExpiryNettingResult {
  const daily = Math.max(0, input.daily);
  const horizon = Math.max(0, Math.floor(input.horizonDays));
  const considered = input.batches
    .filter((b) => b.qty > 0 && b.daysLeft <= horizon)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  let cumulative = 0;
  let expiredQty = 0;
  let unsellableQty = 0;
  let bindingDaysLeft: number | null = null;
  for (const batch of considered) {
    cumulative += batch.qty;
    if (batch.daysLeft <= 0) expiredQty += batch.qty;
    const sellableBefore = daily * Math.max(0, batch.daysLeft);
    const shortfall = cumulative - sellableBefore;
    if (shortfall > unsellableQty) {
      unsellableQty = shortfall;
      bindingDaysLeft = batch.daysLeft;
    }
  }

  return {
    unsellableQty: Math.max(0, Math.round(unsellableQty * 10000) / 10000),
    expiredQty,
    atRiskQty: cumulative,
    batchesConsidered: considered.length,
    bindingDaysLeft: unsellableQty > 0 ? bindingDaysLeft : null,
    minDaysLeft: considered.length ? considered[0].daysLeft : null,
  };
}
