import { describe, expect, it } from "vitest";

import { mineProcessEvents, type ProcessAuditEvent } from "@/server/rules/process-mining";

function event(
  id: number,
  entityId: number | null,
  action: string,
  hour: number,
  overrides: Partial<ProcessAuditEvent> = {},
): ProcessAuditEvent {
  return {
    id,
    entity: "bh",
    entityId,
    action,
    canonicalEvent: null,
    eventDomain: null,
    eventVersion: null,
    isStateChange: null,
    createdAt: new Date(`2026-07-01T${String(hour).padStart(2, "0")}:00:00Z`),
    ...overrides,
  };
}

describe("C154 pure process mining", () => {
  it("calculates adjacent-stage median/P90, variants, and honest coverage", () => {
    const rows = [
      event(1, 1, "create", 0, { after: { docNo: "BH-1" } }),
      event(2, 1, "submit", 1),
      event(3, 1, "approve", 3),
      event(4, 2, "create", 0, { after: { docNo: "BH-2" } }),
      event(5, 2, "submit", 2),
      event(6, 2, "approve", 8),
      event(7, 3, "create", 0, { after: { docNo: "BH-3" } }),
      event(8, 3, "submit", 3),
      event(9, 3, "approve", 12),
      event(10, 4, "create", 4, { after: { docNo: "BH-4" } }),
      event(11, null, "submit", 5),
      event(12, 5, "update", 6),
      event(13, 6, "brand_new_action", 7),
    ];

    const result = mineProcessEvents(rows);
    const createSubmit = result.stages.find((stage) => stage.fromAction === "create" && stage.toAction === "submit");
    const submitApprove = result.stages.find((stage) => stage.fromAction === "submit" && stage.toAction === "approve");

    expect(createSubmit).toMatchObject({
      count: 3,
      medianHours: 2,
      p90Hours: 3,
      reliable: true,
    });
    expect(submitApprove).toMatchObject({
      count: 3,
      medianHours: 6,
      p90Hours: 9,
      reliable: true,
    });
    expect(result.summary).toMatchObject({
      totalEvents: 13,
      mappedEvents: 12,
      stateEvents: 10,
      cases: 4,
      analyzableCases: 3,
      caseCoverageRate: 75,
    });
    expect(result.variants[0]).toMatchObject({
      path: ["创建", "提交审批", "审批通过"],
      cases: 3,
      share: 75,
    });
    expect(result.cases.find((item) => item.docNo === "BH-1")?.totalHours).toBe(3);
  });

  it("collapses immediate retry noise but keeps reject/resubmit variants", () => {
    const result = mineProcessEvents([
      event(1, 1, "create", 0),
      event(2, 1, "submit", 1),
      event(3, 1, "submit", 2),
      event(4, 1, "reject", 3),
      event(5, 1, "submit", 4),
      event(6, 1, "approve", 5),
    ], { minStageSamples: 1 });

    expect(result.cases[0]?.path).toEqual(["创建", "提交审批", "驳回", "提交审批", "审批通过"]);
    expect(result.stages.some((stage) => stage.fromAction === "submit" && stage.toAction === "submit")).toBe(false);
    expect(result.stages.find((stage) => stage.fromAction === "reject" && stage.toAction === "submit")?.count).toBe(1);
  });

  it("prefers persisted canonical identity while legacy rows remain analyzable", () => {
    const result = mineProcessEvents([
      event(1, 1, "create", 0, {
        canonicalEvent: "doc.bh.create",
        eventVersion: "event-v1",
        isStateChange: true,
      }),
      event(2, 1, "submit", 1),
      event(3, 1, "approve", 2, {
        canonicalEvent: "doc.bh.approve",
        eventVersion: "event-v1",
        isStateChange: true,
      }),
    ]);

    expect(result.summary.versionedEvents).toBe(2);
    expect(result.summary.versionedRate).toBe(66.7);
    expect(result.summary.eventMappingRate).toBe(100);
    expect(result.cases[0]?.events.map((item) => item.canonical)).toEqual([
      "doc.bh.create",
      "doc.bh.submit",
      "doc.bh.approve",
    ]);
  });

  it("does not count versioned system fallbacks as mapped business events", () => {
    const result = mineProcessEvents([
      event(1, 1, "unexpected_action", 0, {
        canonicalEvent: "system.unexpected_action",
        eventDomain: "system",
        eventVersion: "event-v1",
        isStateChange: false,
      }),
    ]);

    expect(result.summary.mappedEvents).toBe(0);
    expect(result.summary.eventMappingRate).toBe(0);
    expect(result.summary.versionedEvents).toBe(1);
  });
});
