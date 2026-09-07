import { describe, expect, it } from "vitest";
import { DOCUMENT_PAGES, DOCUMENT_TRANSIENT_PARAMS, documentHref, documentTarget, documentTargetPath } from "@/lib/document-links";
import { persistentListQuery } from "@/components/useListState";

describe("exact document navigation", () => {
  it.each(Object.entries(DOCUMENT_PAGES))("%s selects a database identity, not a matching list row", (type, page) => {
    expect(documentHref(type, 42)).toBe(`${page}?docId=42`);
    expect(documentTarget("docId=42&q=no-match&page=999&status=void")).toEqual({ present: true, id: 42, error: null });
  });
  it.each([0, -1, 1.2, NaN, Infinity, 2147483648])("does not produce a link for invalid identity %s", id => {
    expect(documentHref("bh", id)).toBeNull();
    expect(() => documentTargetPath("/outsource/bh", "", id)).toThrow();
  });
  it.each(["unknown", "constructor", "__proto__", "toString"])("does not inherit a navigation target for %s", type => {
    expect(documentHref(type, 1)).toBeNull();
  });
  it.each(["", "0", "-1", "1.0", "01", "1e2", "+1", "%201", "NaN", "2147483648", "1&docId=2", "1&docId=1"])("invalid docId %s remains an explicit error", value => {
    expect(documentTarget(`docId=${value}`)).toMatchObject({ present: true, id: null, error: expect.any(String) });
  });
  it("keeps legacy search as search; does not guess identities from document numbers", () => {
    expect(documentTarget("q=BH-0001")).toEqual({ present: false, id: null, error: null });
    expect(documentTarget("docId=2147483647").id).toBe(2147483647);
  });
  it("switching and closing preserves search, dates, sibling tabs, pagination and hash", () => {
    const query = "q=%E4%B8%AD%E6%96%87&status=pending&from=2026-09-01&page=7&fg_q=X&docId=1";
    expect(documentTargetPath("/outsource/bh", query, 9, "#context")).toBe(`/outsource/bh?${query.replace("docId=1", "docId=9")}#context`);
    expect(documentTargetPath("/outsource/bh", query, null, "#context")).toBe(`/outsource/bh?${query.replace("&docId=1", "")}#context`);
    expect(documentTargetPath("/outsource/bh", "docId=1", null)).toBe("/outsource/bh");
  });
  it("last and saved views exclude selection without changing shared URL state", () => {
    const shared = "q=X&page=2&docId=45";
    expect(persistentListQuery(shared, DOCUMENT_TRANSIENT_PARAMS)).toBe("q=X&page=2");
    expect(persistentListQuery("docId=1&docId=2", DOCUMENT_TRANSIENT_PARAMS)).toBe("");
    expect(persistentListQuery(shared)).toBe(shared); // unrelated list contracts remain unchanged
    expect(documentTarget(shared).id).toBe(45);
  });
});
