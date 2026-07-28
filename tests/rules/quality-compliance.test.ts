import { describe, expect, it } from "vitest";
import {
  add15UsFederalBusinessDays,
  addUsFederalBusinessDays,
  adverseEventFollowUpThrough,
  adverseEventRetentionThrough,
  canonicalJson,
  canonicalJsonSha256,
  classifyDueState,
  gmpSelfInspectionRetentionThrough,
  isUsFederalBusinessDay,
  isRealIsoDate,
  usFederalObservedHolidays,
  type CanonicalJsonValue,
} from "@/server/rules/quality-compliance";

describe("US federal business-day calendar", () => {
  it("contains the recurring federal holidays and standard weekend observations", () => {
    const holidays2026 = usFederalObservedHolidays(2026);
    expect(holidays2026).toContain("2026-01-19"); // MLK: third Monday
    expect(holidays2026).toContain("2026-05-25"); // Memorial Day: last Monday
    expect(holidays2026).toContain("2026-06-19"); // Juneteenth
    expect(holidays2026).toContain("2026-07-03"); // July 4 Saturday -> Friday
    expect(holidays2026).toContain("2026-11-26"); // Thanksgiving: fourth Thursday
  });

  it("handles an observed New Year's Day that crosses into the prior calendar year", () => {
    expect(usFederalObservedHolidays(2022)).toContain("2021-12-31");
    expect(isUsFederalBusinessDay("2021-12-31")).toBe(false);
    expect(isUsFederalBusinessDay("2022-01-03")).toBe(true);
  });

  it("includes Juneteenth only from enactment in 2021", () => {
    expect(usFederalObservedHolidays(2020)).not.toContain("2020-06-19");
    expect(usFederalObservedHolidays(2021)).toContain("2021-06-18");
  });

  it("rejects weekends and observed holidays but accepts an ordinary weekday", () => {
    expect(isUsFederalBusinessDay("2026-07-04")).toBe(false);
    expect(isUsFederalBusinessDay("2026-07-03")).toBe(false);
    expect(isUsFederalBusinessDay("2026-07-06")).toBe(true);
  });

  it("adds 15 start-exclusive business days across an observed holiday", () => {
    expect(add15UsFederalBusinessDays("2026-07-02")).toBe("2026-07-24");
  });

  it("handles Christmas and the cross-year observed New Year's holiday", () => {
    expect(add15UsFederalBusinessDays("2021-12-16")).toBe("2022-01-10");
  });

  it("excludes Thanksgiving and preserves a deterministic zero-day result", () => {
    expect(add15UsFederalBusinessDays("2026-11-20")).toBe("2026-12-14");
    expect(addUsFederalBusinessDays("2026-11-26", 0)).toBe("2026-11-26");
  });

  it("rejects invalid dates and invalid day counts instead of normalizing silently", () => {
    expect(() => isUsFederalBusinessDay("2026-02-30")).toThrow(/real YYYY-MM-DD/);
    expect(() => addUsFederalBusinessDays("07/02/2026", 15)).toThrow(/YYYY-MM-DD/);
    expect(() => addUsFederalBusinessDays("2026-07-02", -1)).toThrow(/non-negative integer/);
    expect(() => addUsFederalBusinessDays("2026-07-02", 1.5)).toThrow(/non-negative integer/);
  });
});

describe("compliance retention floors", () => {
  it("keeps adverse-event records for a conservative six calendar years", () => {
    expect(adverseEventRetentionThrough("2026-07-29")).toBe("2032-07-29");
    expect(adverseEventFollowUpThrough("2026-07-29")).toBe("2027-07-29");
  });

  it("does not shorten a leap-day adverse-event period", () => {
    expect(adverseEventRetentionThrough("2024-02-29")).toBe("2030-03-01");
  });

  it("keeps GMP self-inspection reports for at least two calendar years", () => {
    expect(gmpSelfInspectionRetentionThrough("2026-07-29")).toBe("2028-07-29");
    expect(gmpSelfInspectionRetentionThrough("2024-02-29")).toBe("2026-03-01");
  });
});

describe("strict calendar dates", () => {
  it("accepts real leap dates and rejects normalized/impossible dates", () => {
    expect(isRealIsoDate("2024-02-29")).toBe(true);
    expect(isRealIsoDate("2026-02-29")).toBe(false);
    expect(isRealIsoDate("2026-04-31")).toBe(false);
    expect(isRealIsoDate("2026-7-2")).toBe(false);
  });
});

describe("canonical JSON evidence digest", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = { z: [3, { beta: true, alpha: "x" }], a: 1 };
    const right = { a: 1, z: [3, { alpha: "x", beta: true }] };

    expect(canonicalJson(left)).toBe('{"a":1,"z":[3,{"alpha":"x","beta":true}]}');
    expect(canonicalJsonSha256(left)).toBe(canonicalJsonSha256(right));
  });

  it("produces a stable known SHA-256 value", () => {
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("distinguishes evidence when array order or a label changes", () => {
    expect(canonicalJsonSha256({ lots: ["A", "B"] })).not.toBe(
      canonicalJsonSha256({ lots: ["B", "A"] }),
    );
    expect(canonicalJsonSha256({ label: "v1" })).not.toBe(
      canonicalJsonSha256({ label: "v2" }),
    );
  });

  it("does not mutate the evidence object", () => {
    const evidence = { z: { second: 2, first: 1 }, a: ["b", "a"] };
    const before = JSON.stringify(evidence);
    canonicalJsonSha256(evidence);
    expect(JSON.stringify(evidence)).toBe(before);
  });

  it("rejects values that JSON would otherwise erase or coerce", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalJson(new Date() as unknown as CanonicalJsonValue)).toThrow(/plain objects/);
    expect(() => canonicalJson({ missing: undefined } as unknown as CanonicalJsonValue)).toThrow();
  });

  it("rejects circular and sparse evidence structures", () => {
    const circular: Record<string, CanonicalJsonValue> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/);

    const sparse = Array<CanonicalJsonValue>(2);
    sparse[1] = "present";
    expect(() => canonicalJson(sparse)).toThrow(/sparse/);
  });
});

describe("due-state classifier", () => {
  const basis = {
    asOfDate: "2026-07-29",
    dueSoonThroughDate: "2026-08-28",
  };

  it.each([
    ["2026-08-29", null, "not_due"],
    ["2026-07-29", null, "due_soon"],
    ["2026-08-28", null, "due_soon"],
    ["2026-07-28", null, "overdue"],
    ["2026-07-28", "2026-07-29", "completed"],
  ] as const)("classifies due %s completed %s as %s", (dueDate, completedDate, expected) => {
    expect(classifyDueState({ ...basis, dueDate, completedDate })).toBe(expected);
  });

  it("does not let a future completion rewrite an earlier as-of state", () => {
    expect(classifyDueState({
      ...basis,
      dueDate: "2026-07-28",
      completedDate: "2026-07-30",
    })).toBe("overdue");
  });

  it("requires an explicit non-backward due-soon horizon and valid dates", () => {
    expect(() => classifyDueState({
      dueDate: "2026-08-01",
      asOfDate: "2026-07-29",
      dueSoonThroughDate: "2026-07-28",
    })).toThrow(/on or after/);
    expect(() => classifyDueState({
      dueDate: "2026-13-01",
      asOfDate: "2026-07-29",
      dueSoonThroughDate: "2026-08-28",
    })).toThrow(/real YYYY-MM-DD/);
  });
});
