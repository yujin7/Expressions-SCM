import React, { Suspense } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import SupplierPage from "@/app/(app)/master/supplier/page";
import { buildFetchQuery, parseQuery } from "@/components/useListState";

vi.mock("@/app/(app)/master/supplier/supplier-client", () => ({ default: "supplier-client" }));
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());

describe("supplier search deep-link boundary", () => {
  it("places URL state within Suspense rather than remounting the whole editor on search", () => {
    expect(SupplierPage().type).toBe(Suspense);
    const client = readFileSync("src/app/(app)/master/supplier/supplier-client.tsx", "utf8");
    const table = readFileSync("src/components/CrudTable.tsx", "utf8");
    expect(client).toContain("listState={list}");
    expect(client).not.toContain("key={initialQuery}");
    expect(table).toContain('key={listState ? listState.filters.q ?? "" : undefined}');
    expect(table).toContain('defaultValue={listState ? listState.filters.q ?? "" : initialQuery}');
  });
  it("restores search, sorting, status and pagination equally for shared URLs and fetch", () => {
    const defaults = { q: "", sort: "code", order: "asc", status: "" };
    const parsed = parseQuery("q=QA-SPIKE-SUP&status=paused&sort=name&order=desc&page=2&pageSize=20", defaults);
    const params = new URLSearchParams(buildFetchQuery(parsed.filters, parsed.page, parsed.pageSize, defaults));
    expect(Object.fromEntries(params)).toEqual({ q: "QA-SPIKE-SUP", status: "paused", sort: "name", order: "desc", page: "2", pageSize: "20" });
  });
});
