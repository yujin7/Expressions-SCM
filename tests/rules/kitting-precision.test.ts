import { expect, it } from "vitest";
import { producibleQty, suggestBatchQty } from "@/server/rules/kitting";

it.each([
  ["3", "1", "1", "3"],
  ["3000", "1", "1", "3000"],
  ["1000", "0.0001", "0.0001", "1000"],
  ["1000", "0.0001", "0", "0"],
  ["10000000", "10000000", "0.999999", "0"],
  ["9999999999.9999", "0.0001", "9999999999.9999", "999999999999980000000000"],
])("exact floor(received × WO / gross): WO=%s gross=%s received=%s", (wo, grossReq, netIssued, result) => {
  expect(String(producibleQty(wo, [{ materialSkuId: 1, grossReq, netIssued }]))).toBe(result);
});

it("a tiny positive requirement with no material remains the bottleneck", () => {
  expect(String(producibleQty("1000", [
    { materialSkuId: 1, grossReq: "0.0001", netIssued: "0" },
    { materialSkuId: 2, grossReq: "1000", netIssued: "1000" },
  ]))).toBe("0");
});

it("fractional prior batches do not lose one complete decimal order multiple", () => {
  expect(suggestBatchQty({ producible: "10", woQty: "10", alreadyBatched: "0.1", orderMultiple: "3.3" })).toBe("9.9000");
});

it("large capacity stays exact in JSON and is capped by WO before any draft quantity is returned", () => {
  const producible = producibleQty("9999999999.9999", [{ materialSkuId: 1, grossReq: "0.0001", netIssued: "9999999999.9999" }]);
  expect(JSON.parse(JSON.stringify({ producible })).producible).toBe("999999999999980000000000");
  expect(suggestBatchQty({ producible, woQty: "9999999999.9999", alreadyBatched: "0", orderMultiple: "1.1" })).toBe("9999999999.0000");
});

it("capacity is the exact maximal feasible integer across 750 deterministic decimal cases", () => {
  // Independent integer inequality oracle. Schema inputs are four-decimal units.
  const str = (u: bigint) => `${u / 10000n}.${(u % 10000n).toString().padStart(4, "0")}`;
  for (let seed = 1n; seed <= 750n; seed++) {
    const wo = seed * 10007n, gross = (seed * 31n) % 983n + 1n, received = (seed * 47n) % 1777n;
    const result = BigInt(producibleQty(str(wo), [{ materialSkuId: 1, grossReq: str(gross), netIssued: str(received) }]));
    const numerator = received * wo, denominator = gross * 10000n;
    expect(result * denominator <= numerator).toBe(true);
    expect((result + 1n) * denominator > numerator).toBe(true);
  }
});

it.each([null, "0", "-1", "0.5", "1"])("preserves whole-unit fallback for multiple %s", orderMultiple => {
  expect(suggestBatchQty({ producible: "10", woQty: "10", alreadyBatched: "0.1", orderMultiple })).toBe("9.0000");
});
