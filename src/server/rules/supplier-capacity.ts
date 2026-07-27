import { dAdd, dCmp, dDiv, dMul, dQty } from "@/server/core/decimal";
import { quantile } from "@/server/rules/leadtime-stats";

export const SUPPLIER_CAPACITY_MIN_MONTHS = 6;

export interface CapacityMonth {
  month: string;
  actualQty: string;
}

export interface CapacityStats {
  sampleMonths: number;
  minMonths: number;
  reliable: boolean;
  p50: string | null;
  p90: string | null;
  months: CapacityMonth[];
}

/**
 * Historical active-month throughput distribution.
 *
 * Zero-output calendar months are deliberately absent: they can mean "no orders",
 * not "zero capacity". This is therefore a learned throughput signal, never a
 * contracted capacity. Callers must group by supplier + base UOM before calling.
 */
export function supplierCapacityStats(
  months: CapacityMonth[],
  minMonths = SUPPLIER_CAPACITY_MIN_MONTHS,
): CapacityStats {
  const valid = months
    .filter((m) => /^\d{4}-\d{2}$/.test(m.month) && dCmp(m.actualQty, "0") > 0)
    .map((m) => ({ month: m.month, actualQty: dQty(m.actualQty) }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const values = valid.map((m) => Number(m.actualQty)).sort((a, b) => a - b);
  const p50 = quantile(values, 0.5);
  const p90 = quantile(values, 0.9);
  const reliable = valid.length >= minMonths;
  return {
    sampleMonths: valid.length,
    minMonths,
    reliable,
    p50: reliable && p50 != null ? dQty(String(p50)) : null,
    p90: reliable && p90 != null ? dQty(String(p90)) : null,
    months: valid,
  };
}

export interface CapacityComparison {
  scheduledQty: string;
  candidateQty: string;
  projectedQty: string;
  utilizationPct: string | null;
  overP90: boolean;
  excessQty: string;
}

export function compareCapacity(
  scheduledQty: string,
  candidateQty: string,
  p90: string | null,
): CapacityComparison {
  const scheduled = dQty(scheduledQty);
  const candidate = dQty(candidateQty);
  const projected = dAdd(scheduled, candidate);
  if (p90 == null || dCmp(p90, "0") <= 0) {
    return {
      scheduledQty: scheduled,
      candidateQty: candidate,
      projectedQty: projected,
      utilizationPct: null,
      overP90: false,
      excessQty: "0.0000",
    };
  }
  const overP90 = dCmp(projected, p90) > 0;
  return {
    scheduledQty: scheduled,
    candidateQty: candidate,
    projectedQty: projected,
    utilizationPct: dMul(dDiv(projected, p90, 6), "100", 2),
    overP90,
    excessQty: overP90 ? dAdd(projected, `-${p90}`) : "0.0000",
  };
}
