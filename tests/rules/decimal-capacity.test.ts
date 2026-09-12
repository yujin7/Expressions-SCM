import { expect, it } from "vitest";
import { dFloorToMultiple, dMulDivFloor } from "@/server/core/decimal";

it.each([
  ["2", "1", "3", 0, "0"], ["-2", "1", "3", 0, "-1"],
  ["2", "1", "-3", 0, "-1"], ["-2", "1", "-3", 0, "0"],
  ["2", "1", "3", 4, "0.6666"], ["-2", "1", "3", 4, "-0.6667"],
  ["0.0001", "0.0001", "0.0001", 4, "0.0001"],
  ["1", "1", "1.000001", 0, "0"], ["0", "1", "3", 4, "0.0000"],
] as const)("final floor %s × %s / %s at scale %i", (a, b, c, scale, expected) => {
  expect(dMulDivFloor(a, b, c, scale)).toBe(expected);
});
it.each([
  ["9.9", "3.3", "9.9000"], ["9.8999", "3.3", "6.6000"],
  ["-9.9", "3.3", "-9.9000"], ["-9.9001", "3.3", "-13.2000"],
  ["0.000199", "0.000001", "0.0001"], ["-0.000101", "0.000001", "-0.0002"],
])("floor %s to multiple %s and storage scale", (a, multiple, expected) => {
  expect(dFloorToMultiple(a, multiple)).toBe(expected);
});
it("invalid scales, malformed values and zero divisors reject, never masquerade as zero capacity", () => {
  for (const scale of [-1, 7, 0.5, NaN]) {
    expect(() => dMulDivFloor("1", "1", "1", scale)).toThrow();
    expect(() => dFloorToMultiple("1", "1", scale)).toThrow();
  }
  for (const value of ["", "NaN", "Infinity", "abc"]) expect(() => dMulDivFloor(value, "1", "1")).toThrow();
  expect(() => dMulDivFloor("1", "1", "0")).toThrow("division by zero");
  for (const multiple of ["0", "-1"]) expect(() => dFloorToMultiple("1", multiple)).toThrow();
});
