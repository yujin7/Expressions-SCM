/** Client-only quantity conservation checks; business FEFO remains on the server. */
export type DraftMaterialLine = { skuId: number; skuCode: string; skuName: string | null; baseUom: string; qty: string; batchId: number | null; batchNo: string | null; expiryDate: string | null };
export type FefoDraftResponse = { skuId: number; requestedQty: string; batchCoverage: boolean; allocations: { batchId: number; batchNo: string; expiryDate: string | null; qty: string }[]; fallbackQty: string; shortBy: string; note: string };
export function draftQuantityUnits(value: string): bigint {
  if (typeof value !== "string" || !/^\d{1,10}(\.\d{1,4})?$/.test(value)) throw new Error("数量须为最多10位整数、4位小数，不能留空或使用科学计数法");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(4, "0"));
}
const quantityString = (units: bigint) => `${units / 10000n}.${String(units % 10000n).padStart(4, "0")}`;
export function draftMaterialTotals(lines: DraftMaterialLine[]) {
  if (!lines.length) throw new Error("至少保留一行发料明细");
  const totals = new Map<number, bigint>();
  for (const line of lines) {
    const qty = draftQuantityUnits(line.qty);
    if (qty <= 0n) throw new Error("每行发料数量须大于0；不需发料的行请移除");
    totals.set(line.skuId, (totals.get(line.skuId) ?? 0n) + qty);
  }
  return [...totals].map(([skuId, qty]) => {
    if (qty > 99999999999999n) throw new Error("同一物料合计超出单次配批数量上限，请拆分发料单");
    return { skuId, qty: quantityString(qty) };
  });
}
export function applyDraftFefo(lines: DraftMaterialLine[], results: FefoDraftResponse[]): DraftMaterialLine[] {
  const totals = draftMaterialTotals(lines);
  if (results.length !== totals.length || new Set(results.map(r => r.skuId)).size !== totals.length) throw new Error("配批响应不完整，请重新核对，原明细未替换");
  return totals.flatMap(total => {
    const r = results.find(value => value.skuId === total.skuId), original = lines.find(line => line.skuId === total.skuId)!;
    if (!r || draftQuantityUnits(r.requestedQty) !== draftQuantityUnits(total.qty) || typeof r.batchCoverage !== "boolean" || !Array.isArray(r.allocations)) throw new Error("配批响应与当前物料/数量不符，原明细未替换");
    if (draftQuantityUnits(r.shortBy) !== 0n) throw new Error(`${original.skuCode} 可发库存不足：${r.note}`);
    if (!r.batchCoverage) {
      if (r.allocations.length || draftQuantityUnits(r.fallbackQty) !== 0n) throw new Error("未批次化响应不一致，请重新核对");
      return [{ ...original, qty: total.qty, batchId: null, batchNo: null, expiryDate: null }];
    }
    const seen = new Set<number>();
    const allocated: DraftMaterialLine[] = r.allocations.map(row => {
      if (!Number.isSafeInteger(row.batchId) || row.batchId <= 0 || seen.has(row.batchId) || typeof row.batchNo !== "string" || !row.batchNo.trim() || (row.expiryDate !== null && typeof row.expiryDate !== "string") || draftQuantityUnits(row.qty) <= 0n) throw new Error("配批明细身份或数量无效，原明细未替换");
      seen.add(row.batchId);
      return { ...original, batchId: row.batchId, batchNo: row.batchNo, expiryDate: row.expiryDate, qty: row.qty, skuId: total.skuId };
    });
    const fallback = draftQuantityUnits(r.fallbackQty);
    if (fallback > 0n) allocated.push({ ...original, qty: r.fallbackQty, batchId: null, batchNo: null, expiryDate: null });
    if (allocated.reduce((sum, line) => sum + draftQuantityUnits(line.qty), 0n) !== draftQuantityUnits(total.qty)) throw new Error("配批前后数量不平，原明细未替换");
    return allocated;
  });
}
