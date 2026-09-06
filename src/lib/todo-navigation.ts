/** The selected tab is shareable URL state, independent of each list's filters. */
export type TodoTab = "mine" | "all" | "stats";

/** Exact item links must remain usable after completion; all still enforces server read scope. */
export function todoItemHref(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError("Invalid work item ID");
  return `/todo?tab=all&all_q=${encodeURIComponent(`#${id}`)}`;
}

export function todoTabFromQuery(query: string): TodoTab {
  const params = new URLSearchParams(query);
  const explicit = params.get("tab");
  if (explicit !== null) return explicit === "all" || explicit === "stats" ? explicit : "mine";

  // Existing cockpit/notification links predate tab=. Infer only unambiguous
  // single-list links; a URL retaining several lists' state still defaults to mine.
  const keys = [...params.keys()];
  const mine = keys.some((key) => key.startsWith("mine_"));
  const all = keys.some((key) => key.startsWith("all_"));
  const stats = keys.some((key) => key.startsWith("st_"));
  if (all && !mine && !stats) return "all";
  if (stats && !mine && !all) return "stats";
  return "mine";
}

export function todoTabHref(query: string, tab: string): string {
  const params = new URLSearchParams(query);
  params.set("tab", tab === "all" || tab === "stats" ? tab : "mine");
  return `/todo?${params.toString()}`;
}
