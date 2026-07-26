import { describe, expect, it } from "vitest";

import {
  achievementRate,
  buildDemandSummary,
  buildStockCoverageSummary,
} from "@/server/modules/report/transit-summary";

describe("transit reference decision summaries", () => {
  it("weights demand achievement by quantity instead of averaging channel percentages", () => {
    const result = buildDemandSummary(
      { rowCount: 3, mappedRows: 2, demandQty: 110, doneQty: 60 },
      [
        { name: "大渠道", demandQty: 100, doneQty: 50 },
        { name: "小渠道", demandQty: 10, doneQty: 10 },
      ],
    );
    expect(result.achievementRate).toBe(54.5);
    expect(result.byChannel.map((row) => row.achievementRate)).toEqual([50, 100]);
    expect(achievementRate(0, 0)).toBeNull();
  });

  it("separates unmapped rows from comparable inventory differences", () => {
    const result = buildStockCoverageSummary(
      [
        { skuId: 1, fileQty: 100 },
        { skuId: 2, fileQty: 40 },
        { skuId: null, fileQty: 12 },
      ],
      { 1: 100.4, 2: 10 },
    );
    expect(result).toEqual({
      kind: "stock_summary",
      rowCount: 3,
      comparableRows: 2,
      agreeRows: 1,
      diffRows: 1,
      unmappedRows: 1,
    });
  });
});

