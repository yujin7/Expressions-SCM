import { describe, expect, it } from "vitest";
import { compareDecimalValues } from "@/lib/decimal-sort";

describe("decimal DTO ordering", () => {
  it.each([
    ["9007199254740992.0001", "9007199254740992.0002", -1],
    ["9999999999.9999", "10000000000.0000", -1],
    ["-0.0001", "0", -1],
    ["-3.1000", "-3.2", 1],
    ["0001.2000", "1.2", 0],
    ["-0.0000", "0.0", 0],
    [2, "2.0000", 0],
  ] as const)("compares %s and %s without float conversion", (a, b, expected) => {
    expect(compareDecimalValues(a, b)).toBe(expected);
    expect(compareDecimalValues(b, a)).toBe(expected === 0 ? 0 : -expected);
  });

  it("keeps unknowns last in either AntD sort direction, distinct from zero and negative returns", () => {
    const values = [null, "0.0000", "-2.0000", "0.0001", undefined];
    // Sort row objects: Array.sort itself always moves raw undefined elements to the end.
    const rows = values.map((value) => ({ value }));
    const asc = [...rows].sort((a, b) => compareDecimalValues(a.value, b.value, "last"));
    const desc = [...rows].sort((a, b) => -compareDecimalValues(a.value, b.value, "first"));
    expect(asc.map((r) => r.value)).toEqual(["-2.0000", "0.0000", "0.0001", null, undefined]);
    expect(desc.map((r) => r.value)).toEqual(["0.0001", "0.0000", "-2.0000", null, undefined]);
    expect(compareDecimalValues(null, undefined)).toBe(0);
  });

  it.each(["", "NaN", "Infinity", "1e3", "1,000", "12oops"])("does not turn invalid DTO %s into a zero", (value) => {
    expect(() => compareDecimalValues(value, "0")).toThrow("Invalid decimal sort value");
  });
});
