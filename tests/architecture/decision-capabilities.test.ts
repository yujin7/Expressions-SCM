import { describe, expect, it } from "vitest";
import {
  capabilityReadiness,
  DECISION_CAPABILITIES,
} from "../../src/components/decision-capabilities";

describe("decision capability evidence contracts", () => {
  it("uses unique ids and declares a decision, owner and next action", () => {
    expect(new Set(DECISION_CAPABILITIES.map((item) => item.id)).size).toBe(DECISION_CAPABILITIES.length);
    for (const item of DECISION_CAPABILITIES) {
      expect(item.decision.trim()).not.toBe("");
      expect(item.owner.trim()).not.toBe("");
      expect(item.nextAction.trim()).not.toBe("");
      expect(item.required.length).toBeGreaterThan(0);
    }
  });

  it("only counts named proven prerequisites that belong to the contract", () => {
    for (const item of DECISION_CAPABILITIES) {
      expect(item.proven.every((proof) => item.required.includes(proof))).toBe(true);
      expect(["ready", "partial", "blocked"]).toContain(capabilityReadiness(item));
    }
  });
});
