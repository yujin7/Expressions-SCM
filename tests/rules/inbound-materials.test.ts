import { expect, it } from "vitest";
import { estimateInboundMaterials, type InboundMaterialFact } from "@/server/rules/inbound-materials";
import { dMulDiv } from "@/server/core/decimal";
const base: InboundMaterialFact = { skuId: 1, code: "MAT", unit: "个", gross: "1", issued: "1", returned: "0" };
it("multiplies before division instead of rounding a repeating unit ratio", () => {
  expect(estimateInboundMaterials([base], "3", "3")[0]).toMatchObject({ expected: "1.0000", delta: "0.0000" });
});
it.each([
  ["0.0001", "0.0001", "0.0001", "0.0001"], ["1", "1", "3", "0.3333"],
  ["-1", "1", "3", "-0.3333"], ["1", "1", "-3", "-0.3333"],
  ["9999999999.9999", "10000", "10000", "9999999999.9999"],
  ["1", "0.000099", "2", "0.0000"], ["1", "0.00005", "1", "0.0001"],
])("multiply-divide retains decimal precision: %s * %s / %s", (a,b,d,expected) => {
  expect(dMulDiv(a,b,d)).toBe(expected);
});
it.each([
  { wo: null, inbound: "1", gross: "1", reason: "分母" },
  { wo: "0", inbound: "1", gross: "1", reason: "分母" },
  { wo: "-1", inbound: "1", gross: "1", reason: "分母" },
  { wo: "1", inbound: null, gross: "1", reason: "入库依据" },
  { wo: "1", inbound: "1", gross: null, reason: "工单外物料" },
  { wo: "1", inbound: "1", gross: "-1", reason: "毛用量异常" },
])("keeps invalid/missing basis unknown: %j", f => {
  const row = estimateInboundMaterials([{ ...base, gross: f.gross }], f.wo, f.inbound)[0];
  expect(row.expected).toBeNull(); expect(row.delta).toBeNull(); expect(row.reason).toContain(f.reason);
});
it("keeps positive and negative per-material differences separate without float noise", () => {
  const rows = estimateInboundMaterials([{ ...base, issued: "8.7", returned: "8.6", gross: "0.1" },
    { ...base, skuId: 2, issued: "0.9", gross: "1" }], "1", "1");
  expect(rows.map(r => r.delta)).toEqual(["0.0000", "-0.1000"]);
});
