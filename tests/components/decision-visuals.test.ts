import { describe, expect, it } from "vitest";

import {
  SERIES_COLORS,
  VISUAL_COLOR,
  coveragePercent,
  coverageText,
  positiveLogAxis,
} from "@/components/decision-visuals";

describe("decision visual semantics", () => {
  it("calculates honest coverage without inventing a percentage", () => {
    expect(coveragePercent({ covered: 301, total: 775 })).toBeCloseTo(38.8387, 4);
    expect(coveragePercent({ covered: 0, total: 0 })).toBeNull();
    expect(coveragePercent()).toBeNull();
    expect(coverageText({ covered: 301, total: 775, label: "可比 SKU" })).toBe(
      "可比 SKU · 301/775 · 38.8%",
    );
  });

  it("never rounds partial coverage into complete or empty coverage", () => {
    expect(coverageText({ covered: 500, total: 502 })).toBe("500/502 · 99.6%");
    expect(coverageText({ covered: 99999, total: 100000 })).toContain(">99.9%");
    expect(coverageText({ covered: 1, total: 100000 })).toContain("<0.1%");
    expect(coveragePercent({ covered: 99999, total: 100000 })).toBeLessThan(100);
    expect(coverageText({ covered: 0, total: 502 })).toContain("0%");
    expect(coverageText({ covered: 502, total: 502 })).toContain("100%");
    expect(coverageText({ percent: 99.999 })).toBe(">99.9%");
  });

  it.each([
    { covered: -1, total: 10 }, { covered: 11, total: 10 },
    { covered: 1, total: 0 }, { covered: NaN, total: 10 },
    { covered: 1, total: Infinity }, { covered: 1, percent: 100 },
    { percent: -1 }, { percent: 101 }, { percent: NaN }, { percent: Infinity },
  ])("does not draw a valid progress bar for invalid or incomplete coverage %j", (coverage) => {
    expect(coveragePercent(coverage)).toBeNull();
    expect(coverageText(coverage)).toMatch(/待核对|未知/);
    expect(coverageText(coverage)).not.toMatch(/NaN|Infinity/);
  });

  it.each([[2.2, 2.2, 2.2], [0, 0], [], [0, 0.01, 0.000001], [0.00000001, 1e10]])(
    "keeps explicit log domains and distinct ticks for %j", (...values: number[]) => {
      const axis = positiveLogAxis(values);
      expect(axis.domain[0]).toBeGreaterThan(0);
      expect(axis.domain[1]).toBeGreaterThan(axis.domain[0]);
      expect(axis.ticks.length).toBeLessThanOrEqual(6);
      expect(new Set(axis.ticks.map(axis.formatTick)).size).toBe(axis.ticks.length);
      for (const value of values.filter((v) => v > 0)) {
        expect(value).toBeGreaterThan(axis.domain[0]);
        expect(value).toBeLessThanOrEqual(axis.domain[1]);
        expect(axis.formatTick(value)).not.toBe("无正日销");
      }
    },
  );

  it("reserves a separate log position only for nonpositive daily values", () => {
    const mixed = positiveLogAxis([0, 0.01, 2.2]);
    expect(mixed.formatTick(mixed.placeholder)).toBe("无正日销");
    expect(mixed.placeholder).toBeLessThan(0.01);
    const positive = positiveLogAxis([0.01, 2.2]);
    expect(positive.ticks.map(positive.formatTick)).not.toContain("无正日销");
  });

  it("keeps stable semantic colors separate from categorical series", () => {
    expect(VISUAL_COLOR.critical).not.toBe(VISUAL_COLOR.positive);
    expect(new Set(SERIES_COLORS).size).toBe(SERIES_COLORS.length);
    expect(SERIES_COLORS).toContain(VISUAL_COLOR.primary);
  });
});
