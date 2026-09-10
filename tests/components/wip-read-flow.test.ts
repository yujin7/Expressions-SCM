import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WipClient from "@/app/(app)/report/wip/wip-client";
import ProcessingCycles from "@/app/(app)/report/wip/processing-cycles";
import type { ListState } from "@/components/useListState";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
const ui = vi.hoisted(() => ({ wide: true, filter: "", cycle: false }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { supplierId: ui.filter, overdueOnly: "", mode: "progress" }, tableSize: "small", queryString: () => ui.filter ? `supplierId=${ui.filter}` : "" }) }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("@/components/DecisionVisual", () => ({ default: "visual" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "select" }));
vi.mock("@/components/ContextHelp", () => ({ default: "help" }));
vi.mock("@/components/DocStatusTag", () => ({ default: "status-tag" }));
vi.mock("@/components/ExportButton", () => ({ AsyncExportButton: "export" }));
vi.mock("antd", () => ({ Button: "button", Card: "card", Col: "col", Grid: { useBreakpoint: () => ({ md: ui.wide }) }, Row: "row", Space: "space", Statistic: "stat", Table: "table", Tabs: "tabs", Tag: "tag", Progress: "progress", Switch: "switch", Typography: { Text: "text", Title: "h4", Paragraph: "p" } }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (v: T | ((p: T) => T)) => { const next = typeof v === "function" ? (v as (p: T) => T)(h.slots[i] as T) : v; if (!Object.is(next, h.slots[i])) h.changed = true; h.slots[i] = next; }]; },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++, prev = h.slots[i] as readonly unknown[] | undefined;
    if (prev?.length === deps.length && prev.every((v, j) => Object.is(v, deps[j]))) return;
    h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children), ...nodes(v.props.dataView as ReactNode), ...nodes(v.props.primaryActions as ReactNode), ...(v.type === "tabs" ? (v.props.items as { children: ReactNode }[]).flatMap(i => nodes(i.children)) : [])] : [];
const mock = vi.fn<typeof fetch>();
const wipData = { rows: [{ jgId: 1, pendingQty: "5" }], summary: { wipCount: 1, overdueCount: 0, pendingTotal: "5" }, suppliers: [] };
const cycleData = { rows: [{ woId: 1 }], summary: { orders: 1, repeats: 1, validRepeats: 0, within20: 0, unresolvedRepeats: 1, unclassified: 0 } };
function render(effects = true): Node {
  for (let i = 0; i < 10; i++) { h.cursor = 0; h.changed = false;
    const tree = (ui.cycle ? ProcessingCycles({ url: `/api/report/wip?mode=cycles&supplierId=${ui.filter || "1"}`, view: { filters: { supplierId: ui.filter, mode: "cycles", overdueOnly: "" }, tableSize: "small" } as ListState<{ supplierId: string; mode: string; overdueOnly: string }> }) : WipClient()) as Node;
    if (!effects) return tree; for (const f of h.effects.splice(0)) f(); if (!h.changed) return tree; }
  throw Error("render did not settle");
}
const flush = async () => { render(); for (let i = 0; i < 25; i++) await Promise.resolve(); return render(); };
const find = (type: string, tree = render()) => nodes(tree).find(n => n.type === type)!;
const cleanup = () => { for (const f of h.cleanups.values()) f(); h.cleanups.clear(); };
beforeEach(() => { cleanup(); h.slots = []; h.effects = []; h.changed = false; ui.wide = true; ui.filter = ""; ui.cycle = false; mock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", mock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([false, true])("view %s withdraws old facts/export immediately on filter change and ignores late responses", async cycle => {
  ui.cycle = cycle; const data = cycle ? cycleData : wipData;
  mock.mockResolvedValueOnce(Response.json(data)); await flush(); expect(find("table").props.dataSource).toHaveLength(1);
  ui.filter = "2"; const pending = Promise.withResolvers<Response>(); mock.mockReturnValueOnce(pending.promise);
  const tree = render(false); expect(find("table", tree).props.dataSource).toEqual([]); expect(nodes(tree).some(n => n.type === "export")).toBe(false);
  render(); ui.filter = "3"; mock.mockResolvedValueOnce(Response.json({ ...data, rows: [] })); await flush(); pending.resolve(Response.json(data)); await flush();
  expect(find("table").props.dataSource).toEqual([]);
});
it.each([false, true])("view %s reports failure and retries GET only; timeout suppresses late success", async cycle => {
  ui.cycle = cycle; mock.mockResolvedValueOnce(Response.json({ error: "暂不可用" }, { status: 503 })); await flush();
  expect(find("load-error").props.error).toContain("暂不可用"); expect(find("table").props.dataSource).toEqual([]);
  const pending = Promise.withResolvers<Response>(); mock.mockReturnValueOnce(pending.promise); (find("load-error").props.onRetry as () => void)(); render();
  await vi.advanceTimersByTimeAsync(15000); expect(find("load-error").props.error).toContain("超时");
  pending.resolve(Response.json(cycle ? cycleData : wipData)); await flush(); expect(find("table").props.dataSource).toEqual([]);
  mock.mockResolvedValueOnce(Response.json(cycle ? cycleData : wipData)); (find("load-error").props.onRetry as () => void)(); await flush();
  expect(find("table").props.dataSource).toHaveLength(1); expect(mock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
it("mobile retains one identity column, no fixed-right overlap, unknown cycle denominator not 0/0", async () => {
  ui.cycle = true; ui.wide = false; mock.mockResolvedValueOnce(Response.json(cycleData)); await flush();
  const cols = find("table").props.columns as { key?: string; fixed?: string; width?: number }[];
  expect(cols[0]).toMatchObject({ key: "identity", width: 164, fixed: "left" }); expect(cols.some(c => c.fixed === "right")).toBe(false);
  expect(nodes(render()).filter(n => n.type === "stat").map(n => n.props.value)).toContain("无可评样本");
});
