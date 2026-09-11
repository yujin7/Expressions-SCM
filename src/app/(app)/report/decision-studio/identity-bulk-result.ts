/** Plain, non-financial review state; never import server values into the client. */
export type IdentityBulkKind = "tmall" | "pdd" | "barcode";
export interface IdentityBulkItem {
  skuId: number;
  skuCode: string;
  shopName?: string;
  platformSkuId?: string;
  barcode?: string;
}
export interface IdentityBulkRow {
  item: IdentityBulkItem;
  status: "saved" | "unchanged" | "rejected" | "unconfirmed";
  detail: string;
}
export interface IdentityBulkReport {
  kind: IdentityBulkKind;
  rows: IdentityBulkRow[];
  readModels: "refreshed" | "deferred" | "unknown";
}
export const identityBulkKey = (kind: IdentityBulkKind, item: IdentityBulkItem) =>
  JSON.stringify([kind, item.skuId, item.shopName ?? "", item.platformSkuId ?? "", item.barcode ?? ""]);
export function identityBulkPayload(kind: IdentityBulkKind, items: IdentityBulkItem[]) {
  return kind === "barcode"
    ? { items: items.map(({ skuId, barcode }) => ({ skuId, barcode })), source: "jiandaoyun-master-mirror" }
    : { items: items.map(({ skuId, shopName, platformSkuId }) => ({ skuId, shopName, platformSkuId, ...(kind === "pdd" ? { platform: "pdd" } : {}) })) };
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function identityBulkReport(kind: IdentityBulkKind, items: IdentityBulkItem[], response: unknown): IdentityBulkReport {
  const result = record(response);
  const invalid = () => { throw new Error("批量响应与提交清单不一致，结果未确认"); };
  if (!Array.isArray(result.results) || result.results.length !== items.length
    || !["refreshed", "deferred"].includes(String(result.readModels))) return invalid();
  const rows = items.map((item, index): IdentityBulkRow => {
    const row = record((result.results as unknown[])[index]);
    if (row.skuId !== item.skuId || (kind !== "barcode" && (row.shopName !== item.shopName || row.platformSkuId !== item.platformSkuId))) return invalid();
    if (kind === "barcode" ? row.status === "filled" : row.ok === true && row.created === true) return { item, status: "saved", detail: kind === "barcode" ? "条码已补齐" : "身份已认领" };
    if (kind === "barcode" ? row.status === "unchanged" : row.ok === true && row.created === false) return { item, status: "unchanged", detail: "此前已一致，无需重复操作" };
    if (kind === "barcode" ? row.status !== "conflict" : row.ok !== false) return invalid();
    if (row.errorKind === "business" && typeof row.error === "string" && row.error.length <= 500) {
      return { item, status: "rejected", detail: row.error };
    }
    return { item, status: "unconfirmed", detail: typeof row.errorId === "string" && /^[a-f0-9]{12}$/.test(row.errorId)
      ? `结果未确认（错误码 ${row.errorId}）；请先核对当前归属，勿重复提交` : "结果未确认；请先核对当前归属，勿重复提交" };
  });
  const saved = rows.filter(row => row.status === "saved").length;
  const unchanged = rows.filter(row => row.status === "unchanged").length;
  if (kind === "barcode"
    ? result.filled !== saved || result.unchanged !== unchanged || result.conflicts !== items.length - saved - unchanged
    : result.total !== items.length || result.claimed !== saved || result.alreadyClaimed !== unchanged || result.failed !== items.length - saved - unchanged) return invalid();
  return { kind, rows, readModels: result.readModels as "refreshed" | "deferred" };
}
export function unconfirmedIdentityBulk(kind: IdentityBulkKind, items: IdentityBulkItem[]): IdentityBulkReport {
  return { kind, readModels: "unknown", rows: items.map(item => ({ item, status: "unconfirmed", detail: "结果未确认；操作可能已完成，请先核对当前归属，勿重复提交" })) };
}
export function mergeIdentityBulk(previous: IdentityBulkReport | undefined, next: IdentityBulkReport): IdentityBulkReport {
  if (!previous || previous.kind !== next.kind) return next;
  const updates = new Map(next.rows.map(row => [identityBulkKey(next.kind, row.item), row]));
  return { ...next, rows: previous.rows.map(row => updates.get(identityBulkKey(previous.kind, row.item)) ?? row) };
}
