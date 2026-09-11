import { describe, expect, it } from "vitest";
import { indexPurchaseLineReceipts } from "@/server/modules/report/purchase-line-receipts";

const lines = [{ id: 1, poId: 10, skuId: 1 }, { id: 2, poId: 10, skuId: 1 }, { id: 3, poId: 20, skuId: 1 }, { id: 4, poId: 10, skuId: 2 }];
describe("只读采购行收货归属", () => {
  it("显式行可拆批；历史唯一SKU兼容且不跨PO", () => {
    const receipts = [
      { poId: 10, skuId: 1, poLineId: 2, qty: "0.1" },
      { poId: 10, skuId: 1, poLineId: 2, qty: "0.2" },
      { poId: 20, skuId: 1, poLineId: null, qty: "7" },
    ];
    const result = indexPurchaseLineReceipts(lines, receipts);
    expect(result.unresolvedLineIds.size).toBe(0);
    expect(result.byLine.has(1)).toBe(false);
    expect(result.byLine.get(2)).toEqual(receipts.slice(0, 2));
    expect(result.byLine.get(3)).toEqual([receipts[2]]);
  });

  it("旧歧义不因处理顺序或另有明确收货而被掩盖", () => {
    const receipts = [{ poId: 10, skuId: 1, poLineId: 1 }, { poId: 10, skuId: 1, poLineId: null }];
    for (const events of [receipts, [...receipts].reverse()]) {
      const result = indexPurchaseLineReceipts(lines, events);
      expect([...result.unresolvedLineIds].sort()).toEqual([1, 2]);
      expect(result.byLine.size).toBe(0);
    }
  });

  it.each([
    { poId: 10, skuId: 1, poLineId: 3, affected: [1, 2, 3] },
    { poId: 10, skuId: 1, poLineId: 4, affected: [1, 2, 4] },
    { poId: 20, skuId: 1, poLineId: 999, affected: [3] },
  ])("显式错误来源不回退唯一SKU：$poLineId", ({ affected, ...receipt }) => {
    const result = indexPurchaseLineReceipts(lines, [receipt]);
    expect([...result.unresolvedLineIds].sort()).toEqual(affected);
    expect(result.byLine.size).toBe(0);
  });

  it("没有收货不制造歧义；不在本报表范围的无关PO不污染当前行", () => {
    const result = indexPurchaseLineReceipts(lines, [{ poId: 99, skuId: 1 }]);
    expect(result.unresolvedLineIds.size).toBe(0);
    expect(result.byLine.size).toBe(0);
  });
});
