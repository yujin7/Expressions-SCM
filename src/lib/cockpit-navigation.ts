/** Summary totals cover every tier; their drill-down must not inherit a narrower list scope. */
export function inventoryCoverMetricFilters(metric: "outOfStock" | "alert" | "watch") {
  return { q: "", tier: "", primary: metric === "outOfStock" ? "out_of_stock" : "",
    status: metric === "outOfStock" ? "" : metric, onlyAlert: "0", showC: "1" };
}
export function inventoryCoverMetricHref(metric: "outOfStock" | "alert" | "watch"): string {
  const params = new URLSearchParams({ tab: "cover" });
  for (const [key, value] of Object.entries(inventoryCoverMetricFilters(metric))) if (value) params.set(`cover_${key}`, value);
  return `/inventory/alerts?${params}`;
}
/** doneThisMonth is the current created cohort, not all completed/manual work. */
export function todoCohortHref(month: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return "/todo?tab=stats";
  return `/todo?${new URLSearchParams({ tab: "stats", st_groupBy: "role", st_from: month, st_to: month })}`;
}
