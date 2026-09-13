import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCtSchema, createFlSchema, createQcSchema, createShSchema, createTlSchema, updateFlSchema, updateTlSchema } from "@/server/modules/matflow/schemas";

const fields = [
  ["FL.qty", createFlSchema.shape.lines.element.shape.qty, false],
  ["FL.update.qty", updateFlSchema.shape.lines.element.shape.qty, false],
  ["TL.qty", createTlSchema.shape.lines.element.shape.qty, false],
  ["TL.update.qty", updateTlSchema.shape.lines.innerType().element.shape.qty, false],
  ["SH.actualQty", createShSchema.shape.lines.element.shape.actualQty, false],
  ["SH.expectedQty", createShSchema.shape.lines.element.shape.expectedQty, false],
  ["QC.passQty", createQcSchema.shape.lines.element.shape.passQty, true],
  ["QC.failQty", createQcSchema.shape.lines.element.shape.failQty, true],
  ["QC.concessionQty", createQcSchema.shape.lines.element.shape.concessionQty, true],
  ["CT.qty", createCtSchema.shape.lines.element.shape.qty, false],
] as const;

describe.each(fields)("%s decimal input", (_label, schema, zeroAllowed) => {
  it("reports malformed values as validation issues without arithmetic exceptions", () => {
    for (const value of ["abc", "NaN", "1e3", "", "  ", "Infinity", "1,000", "1.2.3", "+1", ".5", "1.", "--1", "１２", Number.NaN, Infinity, -Infinity, true, {}, []]) {
      const result = schema.safeParse(value);
      expect(result.success, String(value)).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });
  it("keeps decimal strings, numeric compatibility, trim and the zero/negative policy", () => {
    for (const value of ["0.0001", "1.2345", "9999999999.9999", 1, " 1.25 "]) {
      expect(schema.parse(value)).toBe(String(value).trim());
    }
    expect(schema.safeParse("0").success).toBe(zeroAllowed);
    expect(schema.safeParse("-0").success).toBe(zeroAllowed);
    expect(schema.safeParse("-0.0001").success).toBe(false);
  });
});

it("preserves optional expected receipt quantities without making actual quantities optional", () => {
  const line = { skuId: 1, actualQty: "1" };
  expect(createShSchema.shape.lines.element.parse(line).expectedQty).toBeUndefined();
  expect(createShSchema.shape.lines.element.parse({ ...line, expectedQty: null }).expectedQty).toBeNull();
  expect(createShSchema.shape.lines.element.safeParse({ ...line, actualQty: null }).success).toBe(false);
});

it("preserves return precision and useful nested field paths", () => {
  for (const schema of [createTlSchema.shape.lines.element.shape.qty, updateTlSchema.shape.lines.innerType().element.shape.qty, createCtSchema.shape.lines.element.shape.qty]) {
    for (const value of ["10000000000", "1.00001"]) expect(schema.safeParse(value).success).toBe(false);
  }
  const result = createCtSchema.safeParse({ poId: 1, warehouseId: 1, lines: [{ poLineId: 1, skuId: 1, qty: "abc" }] });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toEqual([
    expect.objectContaining({ path: ["lines", 0, "qty"], message: "必须是十进制数字" }),
  ]);
});
