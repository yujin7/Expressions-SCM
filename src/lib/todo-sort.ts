/** Shared UI/API vocabulary; only these keys may select a server-side SQL expression. */
export const TODO_SORT_FIELDS = ["priority", "status", "dueDate", "createdAt"] as const;
export type TodoSortField = typeof TODO_SORT_FIELDS[number];
export const isTodoSortField = (value: unknown): value is TodoSortField =>
  typeof value === "string" && (TODO_SORT_FIELDS as readonly string[]).includes(value);

export function todoSortPatch(sorter: { columnKey?: unknown; order?: string | null }) {
  if (!sorter.order) return { sortBy: "", sortOrder: "" };
  if (!isTodoSortField(sorter.columnKey) || !["ascend", "descend"].includes(sorter.order)) return null;
  return { sortBy: sorter.columnKey, sortOrder: sorter.order === "descend" ? "desc" : "asc" };
}
