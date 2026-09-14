/** Shared page identities. These are navigation targets, never authorization grants. */
export const DOCUMENT_PAGES: Record<string, string> = {
  bh: "/outsource/bh", wo: "/outsource/wo", po: "/outsource/po", pc: "/outsource/pc",
  jg: "/outsource/jg", fl: "/matflow/fl", tl: "/matflow/tl", sh: "/matflow/sh",
  ct: "/matflow/ct", js: "/settlement/js", stock_doc: "/inventory/docs", pd: "/inventory/count",
  npd: "/npd", quality_case: "/quality",
};

function validId(id: number): boolean { return Number.isInteger(id) && id > 0 && id <= 2_147_483_647; }

export function documentHref(type: string, id: number): string | null {
  const page = Object.hasOwn(DOCUMENT_PAGES, type) ? DOCUMENT_PAGES[type] : null;
  return page && validId(id) ? `${page}?docId=${id}` : null;
}

export function purchaseLineHref(poId: number, lineId: number): string | null {
  const href = documentHref("po", poId);
  return href && validId(lineId) ? `${href}&poLineId=${lineId}` : null;
}

/** A navigation hint only: the PO detail must independently contain this line. */
export function purchaseLineTarget(query: string): number | null {
  const values = new URLSearchParams(query).getAll("poLineId");
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return null;
  const id = Number(values[0]);
  return validId(id) ? id : null;
}

export function documentTarget(query: string) {
  const values = new URLSearchParams(query).getAll("docId");
  if (values.length === 0) return { present: false, id: null, error: null };
  const raw = values[0];
  if (values.length !== 1 || !/^[1-9]\d*$/.test(raw) || !validId(Number(raw))) {
    return { present: true, id: null, error: "单据链接无效，请关闭详情后重新选择单据，或向发送人索取新链接。" };
  }
  return { present: true, id: Number(raw), error: null };
}

/** Change only the selected document. Search, date window, paging and hash survive closing. */
export function documentTargetPath(pathname: string, query: string, id: number | null, hash = "") {
  if (id !== null && !validId(id)) throw new Error("无效的单据 ID");
  const params = new URLSearchParams(query);
  if (String(id) !== params.get("docId")) params.delete("poLineId");
  if (id === null) params.delete("docId"); else params.set("docId", String(id));
  return `${pathname}${params.size ? `?${params}` : ""}${hash}`;
}

export const DOCUMENT_TRANSIENT_PARAMS = ["docId", "poLineId", "workFrom"] as const;

// Return only to known read workspaces, carrying list filters, never command/prefill inputs.
const WORK_PAGES: Record<string, { label: string; keys: readonly string[] }> = {
  "/inventory/docs": { label: "库存单据", keys: ["q", "status", "subtype", "page", "pageSize"] },
  "/matflow/ct": { label: "采购退货", keys: ["q", "status", "page", "pageSize"] },
  "/outsource/bh": { label: "备货申请", keys: ["q", "status", "from", "to", "page", "pageSize"] },
  "/replenish": { label: "补货建议", keys: ["q", "coverDays", "minCover", "sortBy", "sortOrder", "tier", "ownership", "hideTierC", "page", "pageSize"] },
  "/replenish/move-or-buy": { label: "先挪后买", keys: ["q", "page", "pageSize"] },
  "/report/transfer-suggest": { label: "调拨建议", keys: ["q", "skuIds", "page", "pageSize"] },
  "/report/auto-replenish": { label: "自动补货候选", keys: [] },
};
export interface WorkReturn { href: string; label: string }

/** Untrusted URL hints cannot become external, auth, API, nested return or automatic-create targets. */
export function safeWorkReturn(raw: string): WorkReturn | null {
  if (raw.length > 4096 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u0020]/.test(raw)) return null;
  try {
    const url = new URL(raw, "https://scm.invalid");
    if (url.origin !== "https://scm.invalid" || !Object.hasOwn(WORK_PAGES, url.pathname)) return null;
    const page = WORK_PAGES[url.pathname], query = new URLSearchParams();
    for (const key of page.keys) for (const value of url.searchParams.getAll(key)) query.append(key, value);
    return { href: `${url.pathname}${query.size ? `?${query}` : ""}${url.hash}`, label: page.label };
  } catch { return null; }
}

export function workReturnTarget(query: string): WorkReturn | null {
  const values = new URLSearchParams(query).getAll("workFrom");
  return values.length === 1 ? safeWorkReturn(values[0]) : null;
}

/** Same-page recovery keeps the list. Cross-page recovery carries one bounded return context. */
export function recoveryDocumentHref(type: string, id: number, pathname: string, query: string, hash = ""): string | null {
  const target = documentHref(type, id);
  if (!target) return null;
  if (DOCUMENT_PAGES[type] === pathname) {
    const params = new URLSearchParams(query);
    for (const key of ["create", "skuId", "disposalId"]) params.delete(key);
    const back = workReturnTarget(query);
    params.delete("workFrom");
    if (back) params.set("workFrom", back.href);
    return documentTargetPath(pathname, params.toString(), id, hash);
  }
  const back = safeWorkReturn(`${pathname}${query ? `?${query.replace(/^\?/, "")}` : ""}${hash}`);
  return back ? `${target}&workFrom=${encodeURIComponent(back.href)}` : target;
}
