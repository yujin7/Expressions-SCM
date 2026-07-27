import { describe, expect, it } from "vitest";
import {
  compareCapacity,
  supplierCapacityStats,
} from "@/server/rules/supplier-capacity";

describe("supplier capacity rules", () => {
  it("learns active-month P50/P90 only after the reliability gate", () => {
    const five = supplierCapacityStats([
      { month: "2026-01", actualQty: "100" },
      { month: "2026-02", actualQty: "200" },
      { month: "2026-03", actualQty: "300" },
      { month: "2026-04", actualQty: "400" },
      { month: "2026-05", actualQty: "500" },
    ]);
    expect(five).toMatchObject({
      sampleMonths: 5,
      minMonths: 6,
      reliable: false,
      p50: null,
      p90: null,
    });

    const six = supplierCapacityStats([
      ...five.months,
      { month: "2026-06", actualQty: "600" },
      { month: "bad", actualQty: "999999" },
      { month: "2025-12", actualQty: "0" },
    ]);
    expect(six).toMatchObject({
      sampleMonths: 6,
      reliable: true,
      p50: "350.0000",
      p90: "550.0000",
    });
  });

  it("is advisory and compares scheduled plus candidate load without float drift", () => {
    expect(compareCapacity("750", "300", "550")).toEqual({
      scheduledQty: "750.0000",
      candidateQty: "300.0000",
      projectedQty: "1050.0000",
      utilizationPct: "190.91",
      overP90: true,
      excessQty: "500.0000",
    });
    expect(compareCapacity("750", "300", null)).toMatchObject({
      utilizationPct: null,
      overP90: false,
      excessQty: "0.0000",
    });
  });
});
