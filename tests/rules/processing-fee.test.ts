import { expect, it } from "vitest";
import { processingFeeAt } from "@/server/rules/processing-fee";
const date = (day: number) => new Date(Date.UTC(2026, 8, day));
const segments = [{ rate: "2.00", effectiveFrom: date(1) }, { rate: "3.00", effectiveFrom: date(5) },
  { rate: "4.00", effectiveFrom: date(10) }, { rate: "5.00", effectiveFrom: date(15) }];
it("normal changes keep historical receipt rates", () => {
  expect(processingFeeAt(date(3), segments, "5")).toBe("2.00");
  expect(processingFeeAt(date(7), segments, "5")).toBe("3.00");
});
it.each([0, 3, 7, 10, 12])("retrospective approval reprices receipt day %s", day => {
  expect(processingFeeAt(date(day), segments, "5", { rate: "4.00", approvedAt: date(10) })).toBe("4.00");
});
it("later prospective change still wins for later receipts", () => {
  expect(processingFeeAt(date(15), segments, "5", { rate: "4.00", approvedAt: date(10) })).toBe("5.00");
});
it("same-time segments retain established last-ID order without mutating history", () => {
  const sameTime = [...segments, { rate: "6.00", effectiveFrom: date(15) }];
  expect(processingFeeAt(date(15), sameTime, "6")).toBe("6.00");
  expect(segments).toHaveLength(4);
});
it("legacy no-segment fallback stays explicit in the service", () => {
  expect(processingFeeAt(date(3), [], "2.50")).toBe("2.50");
  expect(processingFeeAt(date(3), [], "2.50", { rate: "3.00", approvedAt: date(10) })).toBe("3.00");
});
