export const QUALITY_TABS = ["cases", "regulatory", "labels"] as const;
export type QualityTab = typeof QUALITY_TABS[number];

export function qualityTab(query: string): QualityTab {
  const params = new URLSearchParams(query);
  // An exact case target always opens the case workspace, even beside an old tab parameter.
  if (params.has("docId")) return "cases";
  const tab = params.get("tab");
  return QUALITY_TABS.find(value => value === tab) ?? "cases";
}

export function qualityTabPath(pathname: string, query: string, tab: QualityTab, hash = "") {
  const params = new URLSearchParams(query);
  params.set("tab", tab);
  params.delete("docId");
  return `${pathname}?${params}${hash}`;
}

/** Upgrade old alert bookmarks once. Never overwrite an explicitly chosen namespaced filter. */
export function qualityLegacyPath(pathname: string, query: string, hash = ""): string | null {
  const params = new URLSearchParams(query);
  if (qualityTab(query) !== "cases" || !params.has("q")) return null;
  if (!params.has("qc_q")) params.set("qc_q", params.get("q") ?? "");
  params.delete("q");
  return `${pathname}${params.size ? `?${params}` : ""}${hash}`;
}
