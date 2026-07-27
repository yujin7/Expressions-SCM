import { createHash } from "node:crypto";

/**
 * E8-10 machine-decision evidence envelope.
 *
 * This is deliberately a data contract, not a workflow framework. Domain
 * services own their rules and persist this small, immutable envelope beside
 * the recommendation so a later review can distinguish frozen inputs from a
 * recalculation using today's facts.
 */
export const DECISION_ENVELOPE_VERSION = "decision-envelope/v1" as const;

export interface DecisionEnvelope<TInputs, TOutputs, TSourceMeta = Record<string, unknown>> {
  schemaVersion: typeof DECISION_ENVELOPE_VERSION;
  decisionKind: string;
  engine: {
    key: string;
    version: string;
  };
  capturedAt: string;
  businessDate: string;
  sourceMeta: TSourceMeta;
  inputs: TInputs;
  outputs: TOutputs;
  explanations: string[];
  limitations: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function digestDecisionEvidence(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function buildDecisionEnvelope<TInputs, TOutputs, TSourceMeta>(
  value: Omit<DecisionEnvelope<TInputs, TOutputs, TSourceMeta>, "schemaVersion">,
): { envelope: DecisionEnvelope<TInputs, TOutputs, TSourceMeta>; digest: string } {
  const envelope: DecisionEnvelope<TInputs, TOutputs, TSourceMeta> = {
    schemaVersion: DECISION_ENVELOPE_VERSION,
    ...value,
  };
  return { envelope, digest: digestDecisionEvidence(envelope) };
}
