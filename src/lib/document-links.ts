/** Shared page identities. These are navigation targets, never authorization grants. */
export const DOCUMENT_PAGES: Record<string, string> = {
  bh: "/outsource/bh", wo: "/outsource/wo", po: "/outsource/po", pc: "/outsource/pc",
  jg: "/outsource/jg", fl: "/matflow/fl", tl: "/matflow/tl", sh: "/matflow/sh",
  ct: "/matflow/ct", js: "/settlement/js", stock_doc: "/inventory/docs", pd: "/inventory/count",
};

function validId(id: number): boolean { return Number.isInteger(id) && id > 0 && id <= 2_147_483_647; }

export function documentHref(type: string, id: number): string | null {
  const page = Object.hasOwn(DOCUMENT_PAGES, type) ? DOCUMENT_PAGES[type] : null;
  return page && validId(id) ? `${page}?docId=${id}` : null;
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
  if (id === null) params.delete("docId"); else params.set("docId", String(id));
  return `${pathname}${params.size ? `?${params}` : ""}${hash}`;
}

export const DOCUMENT_TRANSIENT_PARAMS = ["docId"] as const;
