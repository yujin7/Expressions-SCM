/** Bounds shared by the browser and the read-only alert lookup mode. No server imports. */
export const ALERT_LOOKUP_MAX_KEYS = 100;
export const ALERT_LOOKUP_MAX_ENCODED_KEYS = 6000;
export type AlertLookupCategory = "inventory_cover" | "sales_spike";

/** JSON preserves commas/pipes in shop identities; bounded batches avoid giant GET URLs. */
export function alertLookupQueries(category: AlertLookupCategory, keys: readonly string[]): string[] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const key of [...new Set(keys)].sort()) {
    if (!key || encodeURIComponent(JSON.stringify([key])).length > ALERT_LOOKUP_MAX_ENCODED_KEYS) {
      throw new Error("告警关联标识无效或过长，请联系管理员核对来源");
    }
    if (batch.length >= ALERT_LOOKUP_MAX_KEYS || encodeURIComponent(JSON.stringify([...batch, key])).length > ALERT_LOOKUP_MAX_ENCODED_KEYS) {
      batches.push(batch); batch = [];
    }
    batch.push(key);
  }
  if (batch.length || !batches.length) batches.push(batch);
  return batches.map(keys => `/api/alerts?${new URLSearchParams({ category, keys: JSON.stringify(keys) })}`);
}
