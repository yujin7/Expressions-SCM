export interface StockReplacement {
  predecessor: { id: number; docNo: string; status: string } | null;
  successor: { id: number; docNo: string; status: string } | null;
  canCreate: boolean;
  reason: string | null;
}
export interface StockReplacementSource { id: number; docNo: string; status: string; replacement: StockReplacement }

/** A missing/foreign source response is unknown, never permission to create. */
export function validStockReplacementSource(value: unknown, id: number): value is StockReplacementSource {
  if (!value || typeof value !== "object") return false;
  const v = value as StockReplacementSource;
  return v.id === id && typeof v.docNo === "string" && v.docNo.length > 0 && typeof v.status === "string"
    && !!v.replacement && typeof v.replacement.canCreate === "boolean"
    && (v.replacement.reason === null || typeof v.replacement.reason === "string")
    && (!v.replacement.canCreate || (v.status === "void" && v.replacement.successor === null && v.replacement.reason === null));
}
