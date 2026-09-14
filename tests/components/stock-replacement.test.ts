import { expect, it } from "vitest";
import { validStockReplacementSource } from "@/components/stock-replacement";
const source = { id: 7, docNo: "RK-EXACT", status: "void", replacement: { predecessor: null, successor: null, canCreate: true, reason: null } };
it("only the exact current eligible source may enable the form", () => {
  expect(validStockReplacementSource(source, 7)).toBe(true);
  expect(validStockReplacementSource(source, 8)).toBe(false);
});
it.each([null, {}, { ...source, replacement: undefined }, { ...source, status: "draft" },
  { ...source, replacement: { ...source.replacement, reason: "不能替代" } },
  { ...source, replacement: { ...source.replacement, successor: { id: 8 } } },
  { ...source, replacement: { ...source.replacement, canCreate: undefined } },
])("missing or contradictory source %j stays unconfirmed", value => { expect(validStockReplacementSource(value, 7)).toBe(false); });
it("an explicit refusal remains readable, not a loading failure or permission", () => {
  const denied = { ...source, replacement: { ...source.replacement, canCreate: false, reason: "已存在后续替代单" } };
  expect(validStockReplacementSource(denied, 7)).toBe(true); expect(denied.replacement.canCreate).toBe(false);
});
