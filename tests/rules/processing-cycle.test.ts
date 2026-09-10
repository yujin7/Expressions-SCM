import { expect, it } from "vitest";
import { processingDays, quantityMilestones } from "@/server/rules/processing-cycle";

const e = (day: number, qty: string, docNo = `SH-${day}`) => ({ at: `2026-08-${String(day).padStart(2, "0")}T10:00:00+08:00`, qty, docNo });
it("finds threshold crossing rather than last receipt; split lines never create extra cycles", () => {
  const result = quantityMilestones("100", [e(1, "40"), e(10, "30"), e(10, "30"), e(20, "5")]);
  expect(result.qty).toBe("105.0000"); expect(result.fullAt).toBe("2026-08-10T02:00:00.000Z");
  expect(result.fullDocs).toEqual(["SH-10"]);
});
it("revokes full completion on reversal, restores only at a new crossing", () => {
  const events = [e(1, "100"), e(5, "-40", "RC-1")];
  expect(quantityMilestones("100", events).fullAt).toBeNull();
  expect(quantityMilestones("100", [...events, e(8, "40")]).fullAt).toBe("2026-08-08T02:00:00.000Z");
});
it("same-time offset and subunit precision cannot create a false completion", () => {
  expect(quantityMilestones("1", [e(1, "0.9999")]).fullAt).toBeNull();
  expect(quantityMilestones("1", [e(1, "1"), e(1, "-1")]).fullAt).toBeNull();
});
it("zero target, missing/invalid time and negative running balance are not valid evidence", () => {
  expect(quantityMilestones("0", [e(1, "1")]).invalid).toBe(true);
  expect(quantityMilestones("1", [{ at: "bad", qty: "1", docNo: "bad" }]).invalid).toBe(true);
  expect(quantityMilestones("1", [e(1, "-1"), e(2, "2")]).fullAt).toBeNull();
});
it("uses Shanghai days and rejects missing or backwards timestamps even on the same day", () => {
  expect(processingDays("2026-08-01T15:00:00Z", "2026-08-01T16:01:00Z")).toBe(1);
  expect(processingDays("2026-08-01T10:00:00Z", "2026-08-01T09:00:00Z")).toBeNull();
  expect(processingDays(null, "2026-08-01")).toBeNull();
  expect(processingDays("2026-08-01", "bad")).toBeNull();
});
