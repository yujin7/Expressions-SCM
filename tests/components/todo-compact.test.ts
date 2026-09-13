import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemTable, StatsTab, TodoItemSummary, type WorkItemRow } from "@/app/(app)/todo/todo-client";
import { clearTodoMutation, loadTodoMutation, TODO_MUTATION_CHANGED } from "@/components/todo-mutation-request";

// Invoke actual component callbacks with deferred requests; CSS/layout is checked separately in a browser.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
const m = vi.hoisted(() => ({ fetch: vi.fn(), patch: vi.fn(), changed: vi.fn(), setFilter: vi.fn(), setPage: vi.fn(),
  filters: {} as Record<string, string>, me: { id: 42, roles: ["pmc"] },
  message: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (next: T | ((old: T) => T)) => {
      const value = typeof next === "function" ? (next as (old: T) => T)(h.slots[i] as T) : next;
      if (!Object.is(value, h.slots[i])) h.changed = true;
      h.slots[i] = value;
    }];
  },
  useRef: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const i = h.cursor++; const old = h.slots[i] as { fn: unknown; deps: unknown[] } | undefined;
    if (!old || deps.some((x, j) => !Object.is(x, old.deps[j]))) h.slots[i] = { fn, deps };
    return (h.slots[i] as { fn: unknown }).fn;
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
    const i = h.cursor++; const old = h.slots[i] as unknown[] | undefined;
    if (old && deps.every((x, j) => Object.is(x, old[j]))) return;
    h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); });
  },
}));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: m.message }) },
  Alert: "alert", Button: "button", Col: "col", Dropdown: "dropdown", Empty: Object.assign(() => null, { PRESENTED_IMAGE_SIMPLE: "simple" }),
  Pagination: "pagination", Row: "row", Select: "select", Space: "space", Spin: "spin", Table: "table", Tabs: "tabs", Tag: "tag", Tooltip: "tooltip",
  DatePicker: { RangePicker: "range" }, Typography: { Text: "text", Paragraph: "paragraph", Title: "title" },
}));
vi.mock("@/components/fetchJson", () => ({ fetchJson: async (url: string, init?: RequestInit) => {
  if (init?.method !== "PATCH") return m.fetch(url, init);
  const body = JSON.parse(String(init.body)), row = await m.patch(url, body);
  const snapshot = { version: body.expectedVersion + 1, status: row.status, assigneeId: row.assigneeId,
    completedAt: row.status === "done" ? "2026-09-13T00:00:00.000Z" : null, suspicious: false };
  return { ...row, ...snapshot, replayed: false, mutationReceipt: { eventId: 7, requestId: body.requestId,
    originalIntent: { expectedVersion: body.expectedVersion, status: body.status ?? null, assigneeId: body.assigneeId ?? null, note: body.note }, originalResult: snapshot } };
} }));
vi.mock("@/components/useMe", () => ({ useMe: () => m.me }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: m.filters, page: 1, pageSize: 20, density: "small", tableSize: "small",
  setFilter: m.setFilter, paginationProps: ({ total }: { total: number }) => ({ total, current: 1, pageSize: 20, onChange: m.setPage }) }) }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/CaliberNote", () => ({ default: "caliber" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/app/(app)/todo/TodoProgressCard", () => ({ default: "progress-card" }));
vi.mock("@/app/(app)/todo/TodoCreateDrawer", () => ({ default: "create-drawer" }));

type Props = { children?: ReactNode; extra?: ReactNode; description?: ReactNode; message?: ReactNode; href?: string;
  dataSource?: unknown[]; columns?: unknown[]; pagination?: unknown; loading?: boolean; detail?: unknown; onExport?: unknown;
  "aria-label"?: string; onClick?: () => Promise<void> | void; onChange?: (value: string) => void; onRetry?: () => void };
function elements(node: ReactNode): React.ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.extra), ...elements(node.props.description)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render(fn: () => React.ReactElement): React.ReactElement {
  for (let i = 0; i < 5; i++) {
    h.cursor = 0; h.changed = false; const tree = fn(); h.effects.splice(0).forEach(fn => fn());
    if (!h.changed) return tree;
  }
  throw Error("did not settle");
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const row: WorkItemRow = { id: 17, version: 1, title: "合成待办：核对物料", detail: "第一行\n长明细末尾证据", assigneeId: 42, assigneeName: "合成计划员", assignerId: 1,
  assignerName: "合成管理员", ownerRole: "pmc", priority: "high", dueDate: null, status: "open", sourceKind: "alert", sourceRef: "9",
  completedAt: null, createdBy: 1, createdAt: "2026-09-01T00:00:00Z", overdue: false, suspicious: false };
const listing = { rows: [row], total: 25, today: "2026-09-07" };
beforeEach(() => { vi.stubGlobal("React", React); vi.clearAllMocks(); m.fetch.mockReset(); m.patch.mockReset();
  const data = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
  vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("navigator", { locks: { request: (_key: string, fn: () => Promise<unknown>) => fn() } });
  h.cursor = 0; h.slots = []; h.effects = []; h.cleanups.clear(); h.changed = false; m.filters = {}; m.me = { id: 42, roles: ["pmc"] }; });
afterEach(() => { h.cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); });

describe("compact todo facts and persistent outcomes", () => {
  it("details expose full text and provenance without hover-only truncation", () => {
    const tree = TodoItemSummary({ row });
    expect(text(tree)).toContain(row.title); expect(text(tree)).toContain(row.detail);
    expect(text(tree)).toContain("合成计划员"); expect(text(tree)).toContain("合成管理员");
    expect(elements(tree).find(e => e.type === "summary")?.props.children).toBe("明细与记录");
    expect(elements(tree).some(e => e.type === "a" && e.props.href?.includes("9"))).toBe(true);
  });
  it.each(["mine", "all"] as const)("%s shares one read, pagination and server ordering across both layouts", async view => {
    m.fetch.mockResolvedValue(listing);
    const run = () => ItemTable({ view, prefix: view, assignees: [], refreshKey: 0, onChanged: m.changed });
    render(run); await flush(); const tree = render(run); const all = elements(tree);
    expect(m.fetch).toHaveBeenCalledOnce();
    expect(all.find(e => e.type === "table")?.props).toMatchObject({ columns: expect.any(Array), dataSource: [row], pagination: false });
    expect(all.find(e => e.type === "table")?.props.columns).toHaveLength(5);
    expect(all.filter(e => e.type === "pagination")).toHaveLength(1);
    expect(all.find(e => e.type === "select" && e.props["aria-label"] === "待办排序字段")?.props.onChange).toBeDefined();
    all.find(e => e.props["aria-label"] === "待办排序字段")!.props.onChange!("createdAt");
    expect(m.setFilter).toHaveBeenLastCalledWith({ sortBy: "createdAt", sortOrder: "asc" });
  });
  it("confirmed completion remains visible after an active-only refresh removes the row; rapid clicks still issue one PATCH", async () => {
    m.fetch.mockResolvedValueOnce(listing).mockResolvedValue({ ...listing, rows: [] });
    const pending = deferred<WorkItemRow>(); m.patch.mockReturnValue(pending.promise);
    let refreshKey = 0;
    const run = () => ItemTable({ view: "mine", prefix: "mine", assignees: [], refreshKey, onChanged: m.changed });
    render(run); await flush(); const button = elements(render(run)).find(e => e.type === "button" && text(e) === "完成待办")!;
    button.props.onClick!(); button.props.onClick!(); expect(m.patch).toHaveBeenCalledExactlyOnceWith("/api/todo/17", { status: "done", expectedVersion: 1, note: null, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    pending.resolve({ ...row, status: "done" }); await flush(); expect(m.changed).toHaveBeenCalledOnce();
    refreshKey++; render(run); await flush(); const tree = render(run);
    const feedback = elements(tree).find(e => e.type === "alert")!;
    expect(text(feedback.props.message)).toContain("#17"); expect(text(feedback.props.message)).toContain("操作已保存");
    expect(elements(feedback).some(e => e.props.href === "/todo?tab=all&all_q=%2317")).toBe(true);
    expect(text(feedback.props.description)).toContain("告警");
    expect(m.message.info).not.toHaveBeenCalled(); // The durable result owns source guidance; no second floating overlay.
    expect(elements(tree).find(e => e.type === "table")?.props.dataSource).toEqual([]);
  });
  it("uncertain writes retain the helper warning and exact-item link without automatic retry", async () => {
    m.fetch.mockResolvedValue(listing); m.patch.mockRejectedValue(new Error("操作可能已在服务端完成，请先核对结果，勿重复提交"));
    const run = () => ItemTable({ view: "mine", prefix: "mine", assignees: [], refreshKey: 0, onChanged: m.changed });
    render(run); await flush(); elements(render(run)).find(e => e.type === "button" && text(e) === "完成待办")!.props.onClick!();
    await flush(); const alert = elements(render(run)).find(e => e.type === "alert")!;
    expect(text(alert.props.message)).toContain("勿重复提交"); expect(m.changed).not.toHaveBeenCalled(); expect(m.patch).toHaveBeenCalledOnce();
    expect(loadTodoMutation(localStorage, 42)).toMatchObject({ itemId: 17, expectedVersion: 1, status: "done" });
    expect(elements(alert).some(e => e.type === "button" && text(e) === "恢复待核对操作")).toBe(true);
    window.dispatchEvent(new Event(TODO_MUTATION_CHANGED));
    expect(elements(render(run)).some(e => e.type === "alert")).toBe(true); // Pending still exists.
    clearTodoMutation(localStorage, 42, loadTodoMutation(localStorage, 42)!.requestId);
    window.dispatchEvent(new Event(TODO_MUTATION_CHANGED));
    expect(elements(render(run)).some(e => e.type === "alert")).toBe(false);
  });
  it("late success after table unmount keeps the recovery record and cannot update the departed view", async () => {
    m.fetch.mockResolvedValue(listing); const pending = deferred<WorkItemRow>(); m.patch.mockReturnValue(pending.promise);
    const run = () => ItemTable({ view: "mine", prefix: "mine", assignees: [], refreshKey: 0, onChanged: m.changed });
    render(run); await flush(); elements(render(run)).find(e => e.type === "button" && text(e) === "完成待办")!.props.onClick!();
    const original = loadTodoMutation(localStorage, 42); expect(original).not.toBeNull();
    h.cleanups.forEach(fn => fn()); pending.resolve({ ...row, status: "done" }); await flush();
    expect(loadTodoMutation(localStorage, 42)).toEqual(original); expect(m.changed).not.toHaveBeenCalled(); expect(m.message.success).not.toHaveBeenCalled();
  });
  it("storage refusal prevents the actual table action from reaching PATCH", async () => {
    m.fetch.mockResolvedValue(listing); vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw Error("quota"); } });
    const run = () => ItemTable({ view: "mine", prefix: "mine", assignees: [], refreshKey: 0, onChanged: m.changed });
    render(run); await flush(); elements(render(run)).find(e => e.type === "button" && text(e) === "完成待办")!.props.onClick!(); await flush();
    expect(m.patch).not.toHaveBeenCalled(); expect(m.message.error).toHaveBeenCalledWith(expect.stringContaining("未发送"));
  });
  it("read-only visible items do not gain mutation buttons in the mobile layout", async () => {
    m.me = { id: 999, roles: ["ops"] }; m.fetch.mockResolvedValue(listing);
    const run = () => ItemTable({ view: "all", prefix: "all", assignees: [], refreshKey: 0, onChanged: m.changed });
    render(run); await flush(); expect(elements(render(run)).some(e => e.type === "button" && text(e) === "完成待办")).toBe(false);
    expect(m.patch).not.toHaveBeenCalled();
  });
  it("statistics remove old rows/caliber/export during refresh and after failure, then permit explicit recovery", async () => {
    const first = { rows: [{ groupKey: "pmc", month: "2026-09", total: 25 }], caliber: "旧口径", groupBy: "role", fromMonth: "2026-09", toMonth: "2026-09" };
    const pending = deferred<typeof first>(); m.fetch.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
    const run = () => StatsTab({ refreshKey: 0 }); render(run); await flush();
    expect(elements(render(run)).find(e => e.type === "table")?.props.dataSource).toEqual(first.rows);
    m.filters = { groupBy: "role", from: "2026-08" }; const loading = elements(render(run));
    expect(loading.find(e => e.type === "table")?.props.dataSource).toEqual([]);
    expect(loading.find(e => e.type === "caliber")?.props.detail).toBeUndefined();
    expect(loading.find(e => e.type === "toolbar")?.props.onExport).toBeUndefined();
    pending.reject(Error("暂不可用")); await flush();
    const failed = elements(render(run)); expect(failed.find(e => e.type === "table")?.props.dataSource).toEqual([]);
    m.fetch.mockResolvedValue({ ...first, rows: [] }); failed.find(e => e.type === "load-error")!.props.onRetry!(); await flush();
    expect(elements(render(run)).find(e => e.type === "table")?.props.dataSource).toEqual([]);
    expect(m.fetch).toHaveBeenCalledTimes(3);
  });
  it("statistics provide a labelled narrow-screen view with all counts and unknown rates, not false zeroes", async () => {
    m.fetch.mockResolvedValue({ rows: [{ groupKey: "pmc", groupLabel: "pmc", month: "2026-09", total: 3, done: 0,
      onTime: 0, overdue: 2, cancelled: 1, suspicious: 0, completionRate: 0, onTimeRate: null }],
      caliber: "服务端口径", groupBy: "role", fromMonth: "2026-09", toMonth: "2026-09" });
    const run = () => StatsTab({ refreshKey: 0 }); render(run); await flush();
    const tree = render(run);
    const cards = elements(tree).find(e => e.type === "ul" && e.props["aria-label"] === "待办完成率明细");
    expect(cards).toBeDefined();
    expect(text(cards)).toContain("生产计划");
    expect(text(cards)).toContain("2026-09");
    expect(text(cards)).toContain("完成率0%");
    expect(text(cards)).toContain("按时率—");
    for (const label of ["总数", "已完成", "按时", "逾期/不按时", "已取消", "可疑"]) expect(text(cards)).toContain(label);
  });
});
