/** Same natural-key order for receipt registration and execution-time metadata locks. */
export function compareBatchIdentity(a: { skuId: number; batchNo: string }, b: { skuId: number; batchNo: string }): number {
  return a.skuId - b.skuId || (a.batchNo < b.batchNo ? -1 : a.batchNo > b.batchNo ? 1 : 0);
}
