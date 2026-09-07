import type { ExternalVelocityBySku } from "@/server/modules/report/external-velocity";

/** Explicit synthetic upstream DTO for consumer tests; not a producer/coverage proof. */
export function externalWindowFixture(net: string | null, anchor = "2026-09-07"): ExternalVelocityBySku["windows"] {
  return Object.fromEntries(([7, 15, 30, 90] as const).map(days => [days, {
    days, startDay: new Date(Date.parse(`${anchor}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10),
    endDay: anchor, complete: net != null, net, requiredSequences: 1, completeSequences: net == null ? 0 : 1,
  }])) as ExternalVelocityBySku["windows"];
}
