import { describe, expect, it } from "vitest";

import {
  buildDecisionEnvelope,
  DECISION_ENVELOPE_VERSION,
  digestDecisionEvidence,
} from "@/server/core/decision-envelope";

describe("E8-10 decision evidence envelope", () => {
  it("builds a versioned envelope and hashes object keys canonically", () => {
    const common = {
      decisionKind: "replenishment_recommendation",
      engine: { key: "time_phased", version: "v2" },
      capturedAt: "2026-07-27T00:00:00.000Z",
      businessDate: "2026-07-27",
      sourceMeta: { snapshotDate: "2026-07-21" },
      inputs: { onHand: "12.0000" },
      outputs: { suggestedQty: "5.0000" },
      explanations: ["frozen"],
      limitations: ["not ATP"],
    };
    const { envelope, digest } = buildDecisionEnvelope(common);
    expect(envelope.schemaVersion).toBe(DECISION_ENVELOPE_VERSION);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(digestDecisionEvidence({
      outputs: common.outputs,
      limitations: common.limitations,
      schemaVersion: DECISION_ENVELOPE_VERSION,
      inputs: common.inputs,
      sourceMeta: common.sourceMeta,
      capturedAt: common.capturedAt,
      businessDate: common.businessDate,
      explanations: common.explanations,
      engine: common.engine,
      decisionKind: common.decisionKind,
    }));
  });
});
