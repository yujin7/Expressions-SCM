/** Approved retrospective baseline overrides earlier receipt segments, never later fee changes. */
export function processingFeeAt(
  receiptAt: Date,
  segments: readonly { rate: string; effectiveFrom: Date }[],
  currentRate: string,
  retroactive?: { rate: string; approvedAt: Date },
): string {
  let rate = retroactive?.rate ?? null;
  for (const segment of segments) {
    // Caller orders by effectiveFrom, then segment ID. Equal-time successors remain eligible;
    // the retrospective segment itself restores its baseline before any later same-time change.
    if (retroactive && segment.effectiveFrom < retroactive.approvedAt) continue;
    if (segment.effectiveFrom <= receiptAt) rate = segment.rate;
  }
  return rate ?? segments[0]?.rate ?? currentRate;
}
