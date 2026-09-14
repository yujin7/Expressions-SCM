import { expect, it } from "vitest";
import { DOCUMENT_TRANSIENT_PARAMS, recoveryDocumentHref, safeWorkReturn, workReturnTarget } from "@/lib/document-links";
import { persistentListQuery } from "@/components/useListState";

it.each([["stock_doc", "/inventory/docs"], ["ct", "/matflow/ct"], ["bh", "/outsource/bh"]])("%s same-page recovery preserves the list and replaces exact identity", (type, path) => {
  expect(recoveryDocumentHref(type, 81, path, "q=NO-MATCH&status=void&page=3&pageSize=10&docId=80&poLineId=4", "#table"))
    .toBe(`${path}?q=NO-MATCH&status=void&page=3&pageSize=10&docId=81#table`);
});
it("opening an existing stock result cannot re-trigger scrap creation", () => {
  expect(recoveryDocumentHref("stock_doc", 81, "/inventory/docs", "create=scrap&skuId=1&disposalId=2&q=kept"))
    .toBe("/inventory/docs?q=kept&docId=81");
});
it.each([
  ["/replenish", "q=中文&coverDays=45&minCover=30&sortBy=orderByDate&sortOrder=ascend&tier=A&ownership=owned&hideTierC=1&page=3&pageSize=50", "补货建议"],
  ["/replenish/move-or-buy", "q=SKU&page=3", "先挪后买"],
  ["/report/transfer-suggest", "q=SKU&skuIds=1,2&page=3", "调拨建议"],
  ["/report/auto-replenish", "", "自动补货候选"],
])("cross-page %s carries its own filtered read-workspace return", (pathname, query, label) => {
  const href = recoveryDocumentHref("stock_doc", 81, pathname, query, "#results")!;
  const target = new URL(href, "http://localhost");
  expect(target.pathname).toBe("/inventory/docs"); expect(target.searchParams.get("docId")).toBe("81");
  const back = workReturnTarget(target.search);
  expect(back?.label).toBe(label); expect(back?.href).toBe(safeWorkReturn(`${pathname}${query ? `?${query}` : ""}#results`)?.href);
  expect(target.searchParams.has("q")).toBe(false); // A source filter is not a destination filter.
});
it("return context strips nested destinations, auto-create flags, credentials and old selection", () => {
  expect(safeWorkReturn("/inventory/docs?q=KEPT&docId=7&create=scrap&skuId=3&disposalId=4&workFrom=%2Flogin&token=SECRET"))
    .toEqual({ href: "/inventory/docs?q=KEPT", label: "库存单据" });
});
it("a return hint survives changing related documents but is not stored as a saved list preference", () => {
  const query = "q=RK&workFrom=%2Freplenish%3Fq%3DSKU&docId=80";
  const href = recoveryDocumentHref("stock_doc", 81, "/inventory/docs", query)!;
  expect(workReturnTarget(href.split("?")[1])).toEqual({ href: "/replenish?q=SKU", label: "补货建议" });
  expect(persistentListQuery(query, DOCUMENT_TRANSIENT_PARAMS)).toBe("q=RK");
});
it.each(["https://evil.test/replenish", "//evil.test/replenish", "javascript:alert(1)", "/\\evil.test", "/api/inventory/stock-doc", "/login", "/signout", "/account/password", "/constructor", "/%2freplenish", "/replenish\n", "/replenish?q=" + "x".repeat(4096)])("rejects unsafe/unknown return %s", value => {
  expect(safeWorkReturn(value)).toBeNull();
  expect(workReturnTarget(new URLSearchParams({ workFrom: value }).toString())).toBeNull();
});
it("duplicate return parameters do not silently choose one", () => {
  expect(workReturnTarget("workFrom=/replenish&workFrom=/inventory/docs")).toBeNull();
  expect(recoveryDocumentHref("ct", 3, "/matflow/ct", "q=KEPT&workFrom=/login")).toBe("/matflow/ct?q=KEPT&docId=3");
});
it("unknown origin has a canonical target but no guessed return", () => {
  expect(recoveryDocumentHref("ct", 3, "/unknown", "q=KEPT")).toBe("/matflow/ct?docId=3");
});
it.each([0, -1, NaN, 1.5, 2147483648])("invalid target identity %s is not navigable", id => {
  expect(recoveryDocumentHref("stock_doc", id, "/replenish", "")).toBeNull();
});
it("unknown/prototype document type is not navigable", () => {
  expect(recoveryDocumentHref("constructor", 3, "/replenish", "")).toBeNull();
});
