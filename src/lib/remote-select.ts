/** Client-safe list protocol helpers; no shared cache or server imports. */
export type RemoteValue = string | number;
export type RemoteRow = Record<string, unknown> & { id: number };
export const REMOTE_PAGE_SIZE = 50;
export const SELECTED_BATCH_SIZE = 50;

export function selectedValueBatches(values: RemoteValue[]): RemoteValue[][] {
  const batches: RemoteValue[][] = [];
  let batch: RemoteValue[] = [];
  for (const value of values) {
    const next = [...batch, value];
    if (batch.length && (next.length > SELECTED_BATCH_SIZE || encodeURIComponent(JSON.stringify(next)).length > 6000)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(value);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function remoteValueKey(value: RemoteValue): string {
  return JSON.stringify([typeof value, value]);
}

export function selectedRemoteValues(value: unknown): RemoteValue[] {
  const values = Array.isArray(value) ? value : [value];
  const unique = new Map<string, RemoteValue>();
  for (const item of values) {
    const raw = item && typeof item === "object" && "value" in item ? item.value : item;
    if ((typeof raw === "string" && raw !== "") || (typeof raw === "number" && Number.isFinite(raw))) {
      unique.set(remoteValueKey(raw), raw);
    }
  }
  return [...unique.values()];
}

export function remoteListUrl(api: string, page: number, search?: string, selectedValues?: RemoteValue[]): string {
  const url = new URL(api, "http://remote-select.local");
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(REMOTE_PAGE_SIZE));
  // Undefined retains the endpoint's fixed q. Hydration never uses the typed search.
  if (search !== undefined && search.trim()) url.searchParams.set("q", search.trim());
  if (selectedValues !== undefined) url.searchParams.set("selectedValues", JSON.stringify(selectedValues));
  else url.searchParams.delete("selectedValues");
  return /^https?:\/\//.test(api) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

export function readRemotePage(body: unknown): { rows: RemoteRow[]; total: number } {
  if (!body || typeof body !== "object") throw new Error("Invalid option list");
  const record = body as Record<string, unknown>;
  const rows = "data" in record ? record.data : record.rows;
  if (!Array.isArray(rows) || !Number.isSafeInteger(record.total) || Number(record.total) < 0
    || rows.some((row) => !row || typeof row !== "object" || !Number.isSafeInteger(row.id) || row.id <= 0)
    || new Set(rows.map((row) => row.id)).size !== rows.length
    || Number(record.total) < rows.length) throw new Error("Invalid option list");
  return { rows: rows as RemoteRow[], total: Number(record.total) };
}

export function mergeRemoteRows(previous: RemoteRow[], incoming: RemoteRow[]): RemoteRow[] {
  const rows = new Map(previous.map((row) => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()];
}

/** Equal business values with conflicting labels must never silently take the last row. */
export function remoteOptions(rows: RemoteRow[], getLabel: (row: RemoteRow) => string,
  getValue: (row: RemoteRow) => RemoteValue, filterRow?: (row: RemoteRow) => boolean) {
  const options = new Map<string, { value: RemoteValue; label: string; disabled: boolean; ambiguous: boolean }>();
  for (const row of rows) {
    if (filterRow && !filterRow(row)) continue;
    const value = getValue(row);
    const key = remoteValueKey(value);
    const label = getLabel(row);
    const previous = options.get(key);
    if (previous && previous.label !== label) {
      options.set(key, { value, label: `${String(value)}（重名，待核对）`, disabled: true, ambiguous: true });
    } else if (!previous) options.set(key, { value, label, disabled: false, ambiguous: false });
  }
  return [...options.values()];
}
