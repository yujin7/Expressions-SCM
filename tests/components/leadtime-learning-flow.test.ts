import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LeadTimeLearningTab from "@/app/(app)/report/supplier-scorecard/leadtime-learning-tab";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
const ui = vi.hoisted(() => ({ wide: true, q: "" }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { q: ui.q }, page: 1, pageSize: 20, tableSize: "small", paginationProps: (v: unknown) => v }) }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/ContextHelp", () => ({ default: "help" }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Card: "card", Col: "col", Grid: { useBreakpoint: () => ({ md: ui.wide }) }, Popconfirm: "confirm", Row: "row", Space: "space", Statistic: "stat", Table: "table", Typography: { Text: "text", Title: "h5" } }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (v: T | ((p: T) => T)) => { const next = typeof v === "function" ? (v as (p: T) => T)(h.slots[i] as T) : v; if (!Object.is(next, h.slots[i])) h.changed = true; h.slots[i] = next; }]; },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++, prev = h.slots[i] as readonly unknown[] | undefined;
    if (prev?.length === deps.length && prev.every((v, j) => Object.is(v, deps[j]))) return;
    h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
type Column = { key?: string; fixed?: string; width?: number; render?: (v: unknown, r: unknown) => ReactNode };
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const mock = vi.fn<typeof fetch>();
const row = { supplierId: 1, supplierName: "长名称包材供应商", skuId: 2, code: "LT-01", name: "面霜包材", samples: 3, promiseSamples: 2, p50: 10, p90: 15, stdev: 2, onTimeRate: 0.5, avgDelayDays: 2, currentLeadDays: 40, suggestLeadDays: 10, suggestReason: "3个独立订单", targetField: "purchaseLeadDays", evidenceKey: "a".repeat(64) };
const data = (canOverride = true) => ({ rows: [row], total: 1, summary: { pairCount: 1, withSuggestion: 1, avgOnTimeRate: 0.5 }, minSamples: 3, leadDeviationTolerancePct: 20, permissions: { canFill: true, canOverride } });
function render(effects = true): Node {
  for (let i = 0; i < 10; i++) { h.cursor = 0; h.changed = false; const tree = LeadTimeLearningTab() as Node;
    if (!effects) return tree; for (const f of h.effects.splice(0)) f(); if (!h.changed) return tree; }
  throw Error("render did not settle");
}
const flush = async () => { render(); for (let i = 0; i < 25; i++) await Promise.resolve(); return render(); };
const find = (type: string, tree = render()) => nodes(tree).find(n => n.type === type)!;
const confirm = () => { const col = (find("table").props.columns as Column[]).find(c => c.key === (ui.wide ? "suggestion" : "identity"))!;
  return nodes(col.render!(null, row)).find(n => n.type === "confirm"); };
const send = () => (confirm()!.props.onConfirm as () => void)();
const posts = () => mock.mock.calls.filter(([, i]) => i?.method === "POST");
const cleanup = () => { for (const f of h.cleanups.values()) f(); h.cleanups.clear(); };
beforeEach(() => { cleanup(); h.slots = []; h.effects = []; h.changed = false; ui.wide = true; ui.q = ""; mock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", mock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("filter change withdraws obsolete facts before effects; late old response cannot replace the current result", async () => {
  mock.mockResolvedValueOnce(Response.json(data())); await flush(); ui.q = "new";
  expect(find("table", render(false)).props.dataSource).toEqual([]);
  const old = Promise.withResolvers<Response>(); mock.mockReturnValueOnce(old.promise); render();
  ui.q = "current"; mock.mockResolvedValueOnce(Response.json({ ...data(), rows: [], total: 0 })); await flush();
  old.resolve(Response.json(data())); await flush(); expect(find("table").props.dataSource).toEqual([]);
});
it("synchronous double confirm sends one evidence-bound write; reload failure cannot erase success", async () => {
  mock.mockResolvedValueOnce(Response.json(data())); await flush();
  const pending = Promise.withResolvers<Response>(); mock.mockReturnValueOnce(pending.promise); send(); send();
  expect(posts()).toHaveLength(1); expect(JSON.parse(posts()[0][1]!.body as string)).toEqual({ skuId: 2, supplierId: 1, leadDays: 10, evidenceKey: row.evidenceKey });
  mock.mockResolvedValueOnce(Response.json({ error: "读取失败" }, { status: 503 }));
  pending.resolve(Response.json({ ok: true, skuId: 2, leadDays: 10 })); await flush(); await flush();
  expect(nodes(render()).some(n => n.type === "alert" && n.props.type === "success")).toBe(true);
  expect(find("load-error").props.error).toContain("读取失败"); expect(find("table").props.dataSource).toEqual([]);
});
it("malformed write success retains an explicit unconfirmed receipt", async () => {
  mock.mockResolvedValueOnce(Response.json(data())); await flush(); mock.mockResolvedValueOnce(Response.json({})); mock.mockResolvedValueOnce(Response.json(data())); send(); await flush(); await flush();
  expect(nodes(render()).some(n => n.type === "alert" && String(n.props.message).includes("回执不完整"))).toBe(true); expect(posts()).toHaveLength(1);
});
it("timeout aborts, warns and only rereads; late success cannot turn it green", async () => {
  mock.mockResolvedValueOnce(Response.json(data())); await flush(); const pending = Promise.withResolvers<Response>(); mock.mockReturnValueOnce(pending.promise); send();
  mock.mockResolvedValueOnce(Response.json(data())); await vi.advanceTimersByTimeAsync(15000); await flush();
  expect(posts()[0][1]!.signal!.aborted).toBe(true); pending.resolve(Response.json({ ok: true, skuId: 2, leadDays: 10 })); await flush();
  expect(nodes(render()).some(n => n.type === "alert" && String(n.props.message).includes("结果未确认"))).toBe(true); expect(posts()).toHaveLength(1);
});
it("leaving cancels write and timer without a late success or reload", async () => {
  mock.mockResolvedValueOnce(Response.json(data())); await flush(); const pending = Promise.withResolvers<Response>(); mock.mockReturnValueOnce(pending.promise); send(); cleanup();
  await vi.advanceTimersByTimeAsync(15000); pending.resolve(Response.json({ ok: true, skuId: 2, leadDays: 10 })); for (let i = 0; i < 25; i++) await Promise.resolve();
  expect(mock).toHaveBeenCalledTimes(2); expect(posts()[0][1]!.signal!.aborted).toBe(true);
});
it("purchasing cannot see an overwrite action; mobile keeps identity and action together without fixed right overlap", async () => {
  mock.mockResolvedValueOnce(Response.json(data(false))); await flush(); expect(confirm()).toBeUndefined();
  cleanup(); h.slots = []; h.effects = []; ui.wide = false; mock.mockResolvedValueOnce(Response.json(data())); await flush();
  const cols = find("table").props.columns as Column[]; expect(cols[0]).toMatchObject({ key: "identity", width: 166, fixed: "left" });
  expect(cols.some(c => c.fixed === "right")).toBe(false); expect(confirm()).toBeDefined();
});
