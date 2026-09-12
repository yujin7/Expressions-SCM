import { expect, it } from "vitest";
import { initialWoPurchaseGroups, isWoGenerationReceipt } from "@/lib/wo-generation";

it("zero suggestions never become gross purchases, fractional suggestions remain exact", () => {
  const rows = [
    { materialSkuId: 1, suggestedQty: "0.0000", grossReq: "100" },
    { materialSkuId: 2, suggestedQty: "0.0001", grossReq: "200" },
    { materialSkuId: 3, suggestedQty: "9999999999.9999", grossReq: "9999999999.9999" },
  ];
  expect(initialWoPurchaseGroups(7, rows)).toEqual([{ supplierId: 7, lines: [
    { materialSkuId: 2, qty: "0.0001", price: "0" }, { materialSkuId: 3, qty: "9999999999.9999", price: "0" },
  ] }]);
  expect(initialWoPurchaseGroups(7, rows.slice(0, 1))).toEqual([]);
  expect(rows[0].suggestedQty).toBe("0.0000");
});
it("unknown quantity is not silently coerced to zero", () => {
  expect(() => initialWoPurchaseGroups(7, [{ materialSkuId: 1, suggestedQty: "unknown" }])).toThrow();
});
it("only complete, identified draft receipts may produce navigation links", () => {
  expect(isWoGenerationReceipt({ pos: [], jg: { id: 2, docNo: "JG-2" } })).toBe(true);
  for (const value of [null, {}, { pos: [], jg: { docNo: "JG-2" } }, { pos: [{ id: -1, docNo: "PO-1" }], jg: { id: 2, docNo: "JG-2" } }, { pos: [], jg: { id: 2, docNo: " " } }]) expect(isWoGenerationReceipt(value)).toBe(false);
});
