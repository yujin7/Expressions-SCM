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
 * - **观测鲜度门（C4）**：批次层来自盘点快照而非账本，`maxStocktakeAgeDays` 之外的层只统计不扣减。
 *   过旧的快照被当成今天的在库时，可以把一个库存充足的 SKU 一路净额到 0（6/30 盘的 6,000 件
 *   对上今天账面的 800 件新货 → 可用在库 0 → 整轮补货）。被排除的量走 `staleQty` 如实上报；
 * - 日均 = 0 时任何批次都卖不掉，但此时引擎本就不产生需求，故整体量仍如实给出、由调用方决定用途；
 * - 展示层 number 运算（与 cover / safetyQty 同准），不产出记账数字。
 */

export interface ExpiryBatch {
  /** 距到期天数（可为负 = 已过期） */
  daysLeft: number;
  qty: number;
  /**
   * 该批次行的观测时点距今天数（batch_stocks.stocktake_date，0 = 今天盘的）。
   * 缺省 0 = 视为今天观测（既有调用方行为不变）。
   */
  stocktakeAgeDays?: number;
}

export interface ExpiryNettingInput {
  batches: ExpiryBatch[];
  /** 日均消耗（≥0） */
  daily: number;
  /** 推演视野（天）；剩余效期超过它的批次不参与判定 */
  horizonDays: number;
  /**
   * 观测鲜度上限（天）：盘点期比今天早过这个天数的批次层**不参与净额**。
   * 缺省 `Infinity` = 不设限（既有调用方行为不变）。
   */
  maxStocktakeAgeDays?: number;
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
  /** 因观测过旧被排除在净额之外的批次合计 */
  staleQty: number;
  staleBatches: number;
  /** 被排除批次里最旧的观测时点距今天数；无排除 = null */
  staleAgeDays: number | null;
  /** 生效的鲜度上限（天）；未设限 = null */
  maxStocktakeAgeDays: number | null;
}

export function netExpiringStock(input: ExpiryNettingInput): ExpiryNettingResult {
  const daily = Math.max(0, input.daily);
  const horizon = Math.max(0, Math.floor(input.horizonDays));
  const maxAge = input.maxStocktakeAgeDays == null || !Number.isFinite(input.maxStocktakeAgeDays)
    ? Infinity
    : Math.max(0, Math.floor(input.maxStocktakeAgeDays));
  const inHorizon = input.batches.filter((b) => b.qty > 0 && b.daysLeft <= horizon);
  /* 鲜度门（C4）：批次参考层是**盘点快照**，不是账本。上一次盘点越久远，
     「那批货今天还在库上」这个前提就越站不住——6 月底盘出的 6,000 件被当作今天的在库，
     与今天账面上另一批新货的 800 件相减，可以把一个库存充足的 SKU 一路净额到 0。
     过旧的层如实计入 staleQty 并在行上说明，但**不参与扣减**。 */
  const stale = inHorizon.filter((b) => (b.stocktakeAgeDays ?? 0) > maxAge);
  const considered = inHorizon
    .filter((b) => (b.stocktakeAgeDays ?? 0) <= maxAge)
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
    staleQty: Math.round(stale.reduce((sum, b) => sum + b.qty, 0) * 10000) / 10000,
    staleBatches: stale.length,
    staleAgeDays: stale.length ? Math.max(...stale.map((b) => b.stocktakeAgeDays ?? 0)) : null,
    maxStocktakeAgeDays: Number.isFinite(maxAge) ? maxAge : null,
  };
}
