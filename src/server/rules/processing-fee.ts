/** Approved retrospective baseline overrides earlier receipt segments, never later fee changes. */
export function processingFeeAt(
  receiptAt: Date,
  segments: readonly { rate: string; effectiveFrom: Date }[],
  currentRate: string,
  retroactive?: { rate: string; approvedAt: Date },
): string {
  let rate = retroactive?.rate ?? null;
  for (const segment of segments) {
    if (retroactive && segment.effectiveFrom <= retroactive.approvedAt) continue;
    if (segment.effectiveFrom <= receiptAt) rate = segment.rate;
  }
  return rate ?? segments[0]?.rate ?? currentRate;
}
