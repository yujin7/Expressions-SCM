import { compareDecimalValues } from "./decimal-sort";

/** A snapshot is a purchase suggestion, never permission to replace zero with gross demand. */
export function initialWoPurchaseGroups(supplierId: number, lines: readonly { materialSkuId: number; suggestedQty: string }[]) {
  const positive = lines.filter(line => compareDecimalValues(line.suggestedQty, "0") > 0)
    .map(line => ({ materialSkuId: line.materialSkuId, qty: line.suggestedQty, price: "0" }));
  return positive.length ? [{ supplierId, lines: positive }] : [];
}

export interface WoGenerationReceipt { pos: { id: number; docNo: string }[]; jg: { id: number; docNo: string } }
export function isWoGenerationReceipt(value: unknown): value is WoGenerationReceipt {
  const doc = (v: unknown): v is { id: number; docNo: string } => {
    if (!v || typeof v !== "object") return false;
    const row = v as Record<string, unknown>;
    return Number.isSafeInteger(row.id) && Number(row.id) > 0 && typeof row.docNo === "string" && row.docNo.trim().length > 0;
  };
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.pos) && row.pos.every(doc) && doc(row.jg);
}
