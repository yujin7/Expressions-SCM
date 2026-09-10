import { dayDiff, shanghaiDay, type DateLike } from "@/server/core/business-day";
import { dAdd, dCmp } from "@/server/core/decimal";

export interface CycleEvent { at: string; qty: string; docNo: string }

/** Same-timestamp lines form one posting event; a later reversal below target revokes completion. */
export function quantityMilestones(target: string, events: CycleEvent[]) {
  const grouped = new Map<string, { qty: string; docs: Set<string> }>();
  let invalid = dCmp(target, "0") <= 0;
  for (const event of events) {
    const time = Date.parse(event.at);
    if (!Number.isFinite(time)) { invalid = true; continue; }
    const key = new Date(time).toISOString();
    const group = grouped.get(key) ?? { qty: "0", docs: new Set<string>() };
    group.qty = dAdd(group.qty, event.qty); group.docs.add(event.docNo); grouped.set(key, group);
  }
  let qty = "0.0000", firstAt: string | null = null, fullAt: string | null = null;
  let fullDocs: string[] = [];
  for (const [at, event] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    qty = dAdd(qty, event.qty);
    if (dCmp(qty, "0") < 0) invalid = true;
    if (firstAt === null && dCmp(qty, "0") > 0) firstAt = at;
    if (dCmp(qty, target) < 0) { fullAt = null; fullDocs = []; }
    else if (fullAt === null) { fullAt = at; fullDocs = [...event.docs].sort(); }
  }
  return { qty, firstAt, fullAt: invalid ? null : fullAt, fullDocs: invalid ? [] : fullDocs, invalid };
}

/** Days are Shanghai calendar days, but same-day reversed timestamps must still be rejected. */
export function processingDays(start: DateLike, finish: DateLike): number | null {
  const a = shanghaiDay(start), b = shanghaiDay(finish);
  if (!a || !b || new Date(finish!).getTime() < new Date(start!).getTime()) return null;
  return dayDiff(a, b);
}
