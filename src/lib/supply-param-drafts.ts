/** Tab-local edit evidence. Not a source of master-data truth or permission. */
export const LEAD_FIELDS = ["normalLeadDays", "logisticsLeadDays", "purchaseLeadDays"] as const;
export type LeadField = typeof LEAD_FIELDS[number];
export type LeadValues = Record<LeadField, number | null>;
export interface SupplyDraft { skuId: number; code: string; base: Partial<LeadValues>; values: Partial<LeadValues> }
export type SupplyDrafts = Record<string, SupplyDraft>;
export const DRAFT_TTL_MS = 8 * 60 * 60 * 1000;

export function editSupplyDraft(drafts: SupplyDrafts, row: LeadValues & { skuId: number; code: string }, field: LeadField, value: number | null): SupplyDrafts {
  const old = drafts[row.skuId];
  const base = { ...old?.base, [field]: old && field in old.base ? old.base[field] : row[field] };
  const values = { ...old?.values, [field]: value };
  if (value === base[field]) { delete base[field]; delete values[field]; }
  const next = { ...drafts };
  if (Object.keys(values).length) next[row.skuId] = { skuId: row.skuId, code: row.code, base, values };
  else delete next[row.skuId];
  return next;
}

export function clearSavedSupplyDraft(drafts: SupplyDrafts, sent: SupplyDraft): SupplyDrafts {
  const current = drafts[sent.skuId];
  if (!current) return drafts;
  const base = { ...current.base }, values = { ...current.values };
  for (const field of LEAD_FIELDS) {
    if (field in sent.values && values[field] === sent.values[field] && base[field] === sent.base[field]) {
      delete base[field]; delete values[field];
    }
  }
  const next = { ...drafts };
  if (Object.keys(values).length) next[sent.skuId] = { ...current, base, values };
  else delete next[sent.skuId];
  return next;
}

export function supplyDraftConflicts(draft: SupplyDraft, current: LeadValues): LeadField[] {
  return LEAD_FIELDS.filter(f => f in draft.values && current[f] !== draft.base[f] && current[f] !== draft.values[f]);
}

export function restoreSupplyDrafts(raw: string | null, now = Date.now()): SupplyDrafts {
  if (!raw || raw.length > 200_000) return {};
  try {
    const stored = JSON.parse(raw);
    if (stored.version !== 1 || !Number.isFinite(stored.savedAt) || now - stored.savedAt > DRAFT_TTL_MS || stored.savedAt > now || !Array.isArray(stored.rows) || stored.rows.length > 500) return {};
    const result: SupplyDrafts = {};
    const validDay = (n: unknown) => n === null || (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 365);
    for (const row of stored.rows) {
      if (!row || !Number.isSafeInteger(row.skuId) || row.skuId <= 0 || typeof row.code !== "string" || row.code.length > 200 || !row.base || !row.values) return {};
      const fields = Object.keys(row.values);
      if (!fields.length || fields.some(f => !LEAD_FIELDS.includes(f as LeadField) || !Object.hasOwn(row.base, f) || !validDay(row.values[f]) || !validDay(row.base[f]))) return {};
      const base: Partial<LeadValues> = {}, values: Partial<LeadValues> = {};
      for (const f of fields as LeadField[]) { base[f] = row.base[f]; values[f] = row.values[f]; }
      result[row.skuId] = { skuId: row.skuId, code: row.code, base, values };
    }
    return result;
  } catch { return {}; }
}

export function serializeSupplyDrafts(drafts: SupplyDrafts, now = Date.now()): string {
  return JSON.stringify({ version: 1, savedAt: now, rows: Object.values(drafts) });
}
