import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stockDocLineSchema, createStockDocSchema } from "@/server/modules/inventory/schemas";
import { updateCountsSchema } from "@/server/modules/inventory/count";
import { createReplenishDraftSchema } from "@/server/modules/replenish/service";

const fields = [
  ["stock quantity", stockDocLineSchema.shape.qty, false],
  ["opening price", stockDocLineSchema.shape.price, true],
  ["counted quantity", updateCountsSchema.innerType().shape.lines.element.shape.countedQty, true],
  ["replenishment quantity", createReplenishDraftSchema.shape.items.element.shape.qty, false],
] as const;
describe.each(fields)("%s input", (_label, schema, allowsZero) => {
  it("returns validation errors instead of arithmetic exceptions for malformed input", () => {
    for (const value of ["abc", "NaN", "1e3", "", " ", "Infinity", "1,000", "1.2.3", "+1", ".5", "1.", "--1", "１２", NaN, Infinity, -Infinity, true, {}, []]) {
      const result = schema.safeParse(value);
      expect(result.success, String(value)).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });
  it("preserves string precision, numeric compatibility, trim and existing sign rules", () => {
    for (const value of ["0.0001", "1.2345", "9999999999.9999", 1, " 1.25 "]) expect(schema.parse(value)).toBe(String(value).trim());
    expect(schema.safeParse("0").success).toBe(allowsZero);
    expect(schema.safeParse("-0").success).toBe(allowsZero);
    expect(schema.safeParse("-0.0001").success).toBe(false);
  });
});

it("keeps opening price optional/null and forbids prices on non-opening documents", () => {
  for (const price of [undefined, null, "0"]) expect(stockDocLineSchema.safeParse({ skuId: 1, qty: "1", price }).success).toBe(true);
  expect(stockDocLineSchema.safeParse({ skuId: 1, qty: null }).success).toBe(false);
  for (const subtype of ["issue_out", "sales_out"]) {
    const result = createStockDocSchema.safeParse({ subtype, warehouseId: 1, lines: [{ skuId: 1, qty: "1", price: "0" }] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "仅期初单可填单价" })]));
  }
});

it("keeps exact error paths without converting bad values to zero", () => {
  const results = [
    [stockDocLineSchema.safeParse({ skuId: 1, qty: "abc" }), ["qty"]],
    [stockDocLineSchema.safeParse({ skuId: 1, qty: "1", price: "abc" }), ["price"]],
    [updateCountsSchema.safeParse({ version: 1, lines: [{ lineId: 1, countedQty: "abc" }] }), ["lines", 0, "countedQty"]],
    [createReplenishDraftSchema.safeParse({ items: [{ skuId: 1, qty: "abc" }] }), ["items", 0, "qty"]],
  ] as const;
  for (const [result, path] of results) {
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual([expect.objectContaining({ path, message: "必须是十进制数字" })]);
  }
});
