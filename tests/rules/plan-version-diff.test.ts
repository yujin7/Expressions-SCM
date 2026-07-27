import { describe, expect, it } from "vitest";

import {
  diffPlanVersions,
  type PlanSnapshotLine,
} from "@/server/rules/plan-version-diff";

function line(skuId: number, overrides: Partial<PlanSnapshotLine> = {}): PlanSnapshotLine {
  return {
    skuId,
    skuCode: `SKU-${skuId}`,
    skuName: `产品 ${skuId}`,
    brand: "EXPRESSIONS",
    baseUom: "件",
    suggestedQty: "100.0000",
    suppressed: false,
    shortageDate: "2026-08-15",
    orderByDate: "2026-08-01",
    orderWindowMissed: false,
    coverFull: "20.00",
    ...overrides,
  };
}

describe("C122 immutable weekly plan diff", () => {
  it("classifies new alerts, resolutions, deterioration, and improvements", () => {
    const result = diffPlanVersions(
      [
        line(1),
        line(2),
        line(3, { suggestedQty: "200.0000", shortageDate: "2026-08-10" }),
        line(4, { suppressed: false }),
      ],
      [
        line(2, { suggestedQty: "150.0000", shortageDate: "2026-08-10" }),
        line(3, { suggestedQty: "100.0000", shortageDate: "2026-08-20" }),
        line(4, { suppressed: true }),
        line(5),
      ],
    );

    expect(result.rows.find((row) => row.skuId === 1)?.category).toBe("resolved");
    expect(result.rows.find((row) => row.skuId === 2)).toMatchObject({
      category: "worsened",
      signals: ["预计短缺日提前", "建议量增加"],
    });
    expect(result.rows.find((row) => row.skuId === 3)?.category).toBe("improved");
    expect(result.rows.find((row) => row.skuId === 4)?.category).toBe("improved");
    expect(result.rows.find((row) => row.skuId === 5)?.category).toBe("new_alert");
    expect(result.summary).toMatchObject({
      total: 5,
      new_alert: 1,
      resolved: 1,
      worsened: 1,
      improved: 2,
    });
  });

  it("keeps conflicting evidence honest instead of forcing one direction", () => {
    const result = diffPlanVersions(
      [line(1, { suggestedQty: "100.0000", shortageDate: "2026-08-15" })],
      [line(1, { suggestedQty: "80.0000", shortageDate: "2026-08-10" })],
    );
    expect(result.rows[0]).toMatchObject({
      category: "mixed",
      signals: ["预计短缺日提前", "建议量下降"],
    });
  });

  it("does not infer deterioration from elapsed days or display-only cover changes", () => {
    const result = diffPlanVersions(
      [line(1, { coverFull: "20.00" })],
      [line(1, { coverFull: "13.00" })],
    );
    expect(result.rows[0]?.category).toBe("stable");
    expect(result.rows[0]?.signals).toEqual([]);
  });
});
