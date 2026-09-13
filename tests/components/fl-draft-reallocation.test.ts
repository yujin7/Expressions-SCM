import { expect, it } from "vitest";
import { applyDraftFefo, draftMaterialTotals, draftQuantityUnits, type DraftMaterialLine, type FefoDraftResponse } from "@/lib/fl-draft-reallocation";

const line: DraftMaterialLine = { skuId: 1, skuCode: "MAT", skuName: "包材", baseUom: "个", qty: "0.1", batchId: 8, batchNo: "OLD", expiryDate: null };
const result: FefoDraftResponse = { skuId: 1, requestedQty: "0.3000", batchCoverage: true, shortBy: "0", fallbackQty: "0", note: "人工核对",
  allocations: [{ batchId: 9, batchNo: "NEW", expiryDate: "2999-01-01", qty: "0.3" }] };
const lines = [line, { ...line, qty: "0.2" }];
it("aggregates split lots exactly and replaces only batch fields, preserving product identity", () => {
  expect(draftMaterialTotals(lines)).toEqual([{ skuId: 1, qty: "0.3000" }]);
  const before = structuredClone(lines);
  const allocation = { ...result.allocations[0], skuCode: "INJECTED", baseUom: "箱", skuId: 99 };
  expect(applyDraftFefo(lines, [{ ...result, allocations: [allocation] }])).toEqual([{ ...line, batchId: 9, batchNo: "NEW", expiryDate: "2999-01-01", qty: "0.3" }]);
  expect(lines).toEqual(before);
});
it.each(["", "1e2", "-1", "0.00001", "10000000000", " 1", "NaN"])("rejects invalid quantity %s", value => {
  expect(() => draftQuantityUnits(value)).toThrow();
});
it("rejects zero, empty drafts and aggregate overflow before any read", () => {
  expect(() => draftMaterialTotals([])).toThrow();
  expect(() => draftMaterialTotals([{ ...line, qty: "0" }])).toThrow();
  expect(() => draftMaterialTotals([{ ...line, qty: "9999999999.9999" }, line])).toThrow("合计超出");
});
it.each([
  [], [result, result], [{ ...result, skuId: 2 }], [{ ...result, requestedQty: "1" }],
  [{ ...result, shortBy: "0.1" }], [{ ...result, allocations: [] }],
  [{ ...result, allocations: [result.allocations[0], result.allocations[0]] }],
  [{ ...result, allocations: [{ ...result.allocations[0], batchId: 0 }] }],
  [{ ...result, allocations: [{ ...result.allocations[0], qty: "0" }] }],
  [{ ...result, batchCoverage: false }],
].map(response => ({ response })))("partial, short, mismatched or malformed preview cannot mutate the original draft %#", ({ response }) => {
  const before = structuredClone(lines);
  expect(() => applyDraftFefo(lines, response)).toThrow();
  expect(lines).toEqual(before);
});
it("explicit historical fallback is distinct from traceable batch stock", () => {
  const preview = applyDraftFefo(lines, [{ ...result, allocations: [{ ...result.allocations[0], qty: "0.1" }], fallbackQty: "0.2" }]);
  expect(preview).toHaveLength(2);
  expect(preview[1]).toMatchObject({ qty: "0.2", batchId: null, batchNo: null, expiryDate: null });
  expect(applyDraftFefo(lines, [{ ...result, batchCoverage: false, allocations: [] }])).toEqual([{ ...line, qty: "0.3000", batchId: null, batchNo: null }]);
});
