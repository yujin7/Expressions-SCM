import { describe, expect, it } from "vitest";

import {
  SERIES_COLORS,
  VISUAL_COLOR,
  coveragePercent,
  coverageText,
} from "@/components/decision-visuals";

describe("decision visual semantics", () => {
  it("calculates honest coverage without inventing a percentage", () => {
    expect(coveragePercent({ covered: 301, total: 775 })).toBe(39);
    expect(coveragePercent({ covered: 0, total: 0 })).toBeNull();
    expect(coveragePercent()).toBeNull();
    expect(coverageText({ covered: 301, total: 775, label: "可比 SKU" })).toBe(
      "可比 SKU · 301/775 · 39%",
    );
  });

  it("keeps stable semantic colors separate from categorical series", () => {
    expect(VISUAL_COLOR.critical).not.toBe(VISUAL_COLOR.positive);
    expect(new Set(SERIES_COLORS).size).toBe(SERIES_COLORS.length);
    expect(SERIES_COLORS).toContain(VISUAL_COLOR.primary);
  });
});

