import { expect, it } from "vitest";
import { ackText } from "@/components/AlertEvidence";

it("acknowledgement instants use Shanghai time including the next business day", () => {
  expect(ackText({ ackedAt: "2026-09-08T06:39:17.254Z", ackedByName: "计划员" })).toBe("计划员 · 2026-09-08 14:39");
  expect(ackText({ ackedAt: "2026-09-08T16:10:00Z", ackedBy: 7 })).toBe("#7 · 2026-09-09 00:10");
  expect(ackText({ ackedAt: "2026-09-09T00:10:00+08:00", ackedBy: 7 })).toBe("#7 · 2026-09-09 00:10");
});

it("missing acknowledgement differs from an unknown or malformed timestamp", () => {
  expect(ackText({ ackedAt: null })).toBe("未知悉");
  expect(ackText({ ackedAt: "not-a-date", ackedByName: "计划员" })).toBe("计划员 · 时间未知");
  expect(ackText({ ackedAt: "2026-09-08T06:39:00", ackedByName: "计划员" })).toBe("计划员 · 时间未知");
});
