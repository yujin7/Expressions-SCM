import { ApiError } from "@/server/modules/master/common";
import { resolvePurchaseReceiptLine } from "@/server/modules/matflow/purchase-receipt-lock";

type PurchaseLine = { id: number; poId: number; skuId: number };
type ReceiptIdentity = { poId: number; skuId: number; poLineId?: number | null };

/**
 * 只读归属索引，复用收货写端的身份规则，不改历史记录。
 * 旧收货无法确定行时，同PO/SKU全部候选行暂停计算：即使另有明确行的收货，
 * 也不能假设这条未知事实属于其他行。显式ID与PO/SKU冲突同时污染两侧候选。
 * 调用方先选择自己的有效事件集合；Map/Set仅为内部计算，不作为DTO下发。
 */
export function indexPurchaseLineReceipts<R extends ReceiptIdentity>(lines: PurchaseLine[], receipts: R[]) {
  const byPo = new Map<number, PurchaseLine[]>();
  const byId = new Map<number, PurchaseLine>();
  const byPoSku = new Map<string, PurchaseLine[]>();
  for (const line of lines) {
    byId.set(line.id, line);
    const poLines = byPo.get(line.poId) ?? [];
    poLines.push(line);
    byPo.set(line.poId, poLines);
    const key = `${line.poId}:${line.skuId}`;
    const skuLines = byPoSku.get(key) ?? [];
    skuLines.push(line);
    byPoSku.set(key, skuLines);
  }
  const byLine = new Map<number, R[]>();
  const unresolvedLineIds = new Set<number>();
  for (const receipt of receipts) {
    try {
      const line = resolvePurchaseReceiptLine(byPo.get(receipt.poId) ?? [], receipt.skuId, receipt.poLineId);
      const events = byLine.get(line.id) ?? [];
      events.push(receipt);
      byLine.set(line.id, events);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      for (const line of byPoSku.get(`${receipt.poId}:${receipt.skuId}`) ?? []) unresolvedLineIds.add(line.id);
      if (receipt.poLineId != null && byId.has(receipt.poLineId)) unresolvedLineIds.add(receipt.poLineId);
    }
  }
  // 不允许消费者无意使用一个仍含歧义的行的部分已知事件。
  for (const id of unresolvedLineIds) byLine.delete(id);
  return { byLine, unresolvedLineIds };
}
