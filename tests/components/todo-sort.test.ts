import { describe, expect, it } from "vitest";
import { TODO_SORT_FIELDS, todoSortPatch } from "@/lib/todo-sort";
import { buildFetchQuery, buildQueryString, parseQuery } from "@/components/useListState";

const defaults = { q: "", status: "active", ownerRole: "", overdue: "", sortBy: "", sortOrder: "" };
describe("todo sortable list URL contract", () => {
  it.each(TODO_SORT_FIELDS)("%s supports both directions and clearing", key => {
    expect(todoSortPatch({ columnKey: key, order: "ascend" })).toEqual({ sortBy: key, sortOrder: "asc" });
    expect(todoSortPatch({ columnKey: key, order: "descend" })).toEqual({ sortBy: key, sortOrder: "desc" });
    expect(todoSortPatch({ columnKey: key, order: null })).toEqual({ sortBy: "", sortOrder: "" });
  });
  it.each([{ columnKey: "sql", order: "ascend" }, { columnKey: "priority", order: "invalid" }])("ignores unsupported UI sort events %j", sorter => {
    expect(todoSortPatch(sorter)).toBeNull();
  });
  it.each(["mine", "all"])("%s persists ordering independently, shares and restores it without changing sibling state", prefix => {
    const sibling = prefix === "mine" ? "all" : "mine";
    const filters = { ...defaults, ...todoSortPatch({ columnKey: "dueDate", order: "descend" }) };
    const base = `tab=${prefix}&${sibling}_q=keep&${sibling}_page=3&st_groupBy=role`;
    const query = buildQueryString(filters, 1, 20, defaults, { paramPrefix: prefix, base, defaultPageSize: 20 });
    const params = new URLSearchParams(query);
    expect(params.get(`${prefix}_sortBy`)).toBe("dueDate");
    expect(params.get(`${prefix}_sortOrder`)).toBe("desc");
    expect(params.get(`${sibling}_q`)).toBe("keep");
    expect(params.get(`${sibling}_page`)).toBe("3");
    expect(params.get("st_groupBy")).toBe("role");
    const restored = parseQuery(query, defaults, { paramPrefix: prefix, defaultPageSize: 20 });
    expect(restored).toMatchObject({ filters, page: 1, pageSize: 20 });
    const api = new URLSearchParams(buildFetchQuery(restored.filters, 2, 20, defaults));
    expect(api.get("sortBy")).toBe("dueDate");
    expect(api.get("sortOrder")).toBe("desc");
    expect(api.get("page")).toBe("2");
    expect(api.has(`${prefix}_sortBy`)).toBe(false);
    const reset = new URLSearchParams(buildQueryString({ ...filters, ...todoSortPatch({ order: null }) }, 1, 20, defaults, { paramPrefix: prefix, base: query, defaultPageSize: 20 }));
    expect(reset.has(`${prefix}_sortBy`)).toBe(false);
    expect(reset.has(`${prefix}_sortOrder`)).toBe(false);
    expect(reset.get(`${sibling}_q`)).toBe("keep");
  });
});
