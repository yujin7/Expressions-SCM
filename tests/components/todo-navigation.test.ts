import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "@/app/(app)/todo/page";

vi.mock("@/app/(app)/todo/todo-client", () => ({ default: "todo-client" }));
vi.mock("next/navigation", () => ({ redirect: (href: string) => { throw new Error(`redirect:${href}`); } }));
beforeEach(() => { vi.stubGlobal("React", React); });
afterEach(() => { vi.unstubAllGlobals(); });
import { todoItemHref, todoTabFromQuery, todoTabHref } from "@/lib/todo-navigation";

describe("todo tab URL navigation", () => {
  it("old delivered notification URLs redirect at the page entry without rewriting stored notifications", async () => {
    await expect(Promise.resolve().then(() => Page({ searchParams: Promise.resolve({ mine_q: "#12" }) }))).rejects.toThrow("redirect:/todo?tab=all&all_q=%2312");
  });
  it.each([
    {}, { mine_q: "SKU" }, { mine_q: "#0" }, { mine_q: "#9007199254740992" },
    { mine_q: ["#12", "#13"] }, { mine_q: "#12", mine_status: "active" },
    { mine_q: "#12", tab: "mine" }, { mine_q: "#12", all_page: "2" },
    { tab: "all", all_q: "#12" },
  ])("preserves explicit or non-legacy query %j", async (query) => {
    const page = await Page({ searchParams: Promise.resolve(query) });
    expect(page.type).toBe(React.Suspense);
  });
  it("links exact items through all statuses without inheriting filters or pagination", () => {
    expect(todoItemHref(12)).toBe("/todo?tab=all&all_q=%2312");
    expect(todoTabFromQuery(todoItemHref(12).split("?")[1])).toBe("all");
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid item ID %s", (id) => {
    expect(() => todoItemHref(id)).toThrow(RangeError);
  });
  it.each(["mine", "all", "stats"] as const)("opens explicit %s even with other list state", (tab) => {
    expect(todoTabFromQuery(`tab=${tab}&mine_status=active&all_ownerRole=pmc&st_month=2026-09`)).toBe(tab);
  });
  it.each(["", "tab=", "tab=unknown", "tab=https%3A%2F%2Fexample.com"])("defaults unsupported state %s to mine", (query) => {
    expect(todoTabFromQuery(query)).toBe("mine");
  });
  it("keeps old cockpit role and completed links usable", () => {
    expect(todoTabFromQuery("all_ownerRole=pmc&all_status=active")).toBe("all");
    expect(todoTabFromQuery("all_status=done")).toBe("all");
    expect(todoTabFromQuery("mine_q=%2312")).toBe("mine");
    expect(todoTabFromQuery("st_month=2026-09")).toBe("stats");
    expect(todoTabFromQuery("all_status=active&mine_q=old")).toBe("mine");
  });
  it("changes only the tab, preserving namespaced lists and unrelated query state", () => {
    const before = "mine_q=%E6%9D%90%E6%96%99&all_page=3&all_ownerRole=pmc&st_month=2026-09&foo=bar&tab=mine";
    const url = new URL(todoTabHref(before, "all"), "https://scm.example");
    expect(url.pathname).toBe("/todo");
    expect(url.searchParams.get("tab")).toBe("all");
    for (const [key, value] of new URLSearchParams(before)) {
      if (key !== "tab") expect(url.searchParams.get(key)).toBe(value);
    }
    expect(todoTabFromQuery(url.search)).toBe("all");
    expect(todoTabFromQuery(before)).toBe("mine");
  });
  it("cannot turn a tab key into an external navigation destination", () => {
    expect(todoTabHref("", "//example.com")).toBe("/todo?tab=mine");
  });
});
