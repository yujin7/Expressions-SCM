import React, { isValidElement } from "react";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import ReplenishPage from "@/app/(app)/replenish/page";

vi.mock("@/app/(app)/replenish/replenish-client", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("not-found"); },
}));
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
type Query = Record<string, string | string[] | undefined>;
const page = async (query: Query) => ReplenishPage({ searchParams: Promise.resolve(query) });

// Wiring contract complements the real-browser return/refresh/history regression.
it("the visible search draft starts from q and resets when URL q changes", () => {
  const source = readFileSync("src/app/(app)/replenish/replenish-client.tsx", "utf8");
  const search = source.match(/<SearchInput\b[\s\S]*?\/>/)?.[0];
  expect(search).toContain("key={q}");
  expect(search).toContain("defaultValue={q}");
  expect(search).toContain("listState.setFilter({ q: value.trim() })");
});

it("old spike and cached capacity-return links redirect before an unfiltered client mounts", async () => {
  await expect(page({ sku: "CAP-UI-SKU" })).rejects.toThrow("redirect:/replenish?q=CAP-UI-SKU");
});
it("legacy code is encoded once while other explicit filters and repeated fields survive", async () => {
  await expect(page({ sku: "精华 A&B/+", tier: "A", page: "2", tag: ["一", "二"] }))
    .rejects.toThrow("redirect:/replenish?tier=A&page=2&tag=%E4%B8%80&tag=%E4%BA%8C&q=%E7%B2%BE%E5%8D%8E+A%26B%2F%2B");
});
it.each(["OTHER", ""])("explicit q=%s wins over the old sku field, including intentional clearing", async q => {
  await expect(page({ sku: "OLD", q })).rejects.toThrow(`redirect:/replenish?q=${q}`);
});
it("an ambiguous old SKU does not silently select one or open the entire list", async () => {
  await expect(page({ sku: ["A", "B"] })).rejects.toThrow("not-found");
});
it("existing canonical searches and unfiltered entry still mount normally", async () => {
  expect(isValidElement(await page({ q: "CURRENT" }))).toBe(true);
  expect(isValidElement(await page({}))).toBe(true);
});
