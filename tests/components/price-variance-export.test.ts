import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierScorecardClient from "@/app/(app)/report/supplier-scorecard/supplier-scorecard-client";

// Actual page callbacks with isolated hooks and deferred fetch/body reads.
// Layout effects run before passive effects. This is lifecycle evidence, not visual QA.
const hooks = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[], layout: [] as (() => void)[], passive: [] as (() => void)[],
  cleanups: new Map<number, () => void>(), changed: false, writes: 0,
}));
const ui = vi.hoisted(() => ({ q: "", windowDays: "180", page: 1, pageSize: 20, tab: "price" }));
const network = vi.hoisted(() => ({ read: vi.fn(), fetch: vi.fn(), error: vi.fn() }));
const notices = vi.hoisted(() => ({ error: network.error, success: vi.fn() }));

vi.mock("react", async (original) => {
  const effect = (queue: (() => void)[], callback: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as readonly unknown[] | undefined;
    if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = deps;
    queue.push(() => {
      hooks.cleanups.get(index)?.(); hooks.cleanups.delete(index);
      const cleanup = callback();
      if (cleanup) hooks.cleanups.set(index, cleanup);
    });
  };
  const memo = (create: () => unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.slots[index] = { value: create(), deps };
    return (hooks.slots[index] as { value: unknown }).value;
  };
  return {
    ...await original<typeof import("react")>(),
    useState: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = initial;
      return [hooks.slots[index], (next: T | ((previous: T) => T)) => {
        const value = typeof next === "function" ? (next as (previous: T) => T)(hooks.slots[index] as T) : next;
        hooks.writes += 1;
        if (!Object.is(value, hooks.slots[index])) hooks.changed = true;
        hooks.slots[index] = value;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
      return hooks.slots[index];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (callback: () => void | (() => void), deps: readonly unknown[]) => effect(hooks.passive, callback, deps),
    useLayoutEffect: (callback: () => void | (() => void), deps: readonly unknown[]) => effect(hooks.layout, callback, deps),
  };
});
vi.mock("antd", () => ({
  App: { useApp: () => ({ message: notices }) },
  Alert: "alert", Button: "button", Card: "card", Col: "col", Row: "row", Space: "space",
  Statistic: "statistic", Table: "table", Tag: "tag", Popconfirm: "popconfirm", Progress: "progress",
  Segmented: "segmented", Tabs: "tabs", Tooltip: "tooltip",
  Typography: { Text: "text", Paragraph: "paragraph", Title: "title" },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ tab: ui.tab }),
}));
vi.mock("@ant-design/icons", () => ({ ReloadOutlined: "reload" }));
vi.mock("recharts", () => ({
  Bar: "bar", BarChart: "bar-chart", CartesianGrid: "grid", Legend: "legend",
  ResponsiveContainer: "chart-container", Tooltip: "chart-tooltip", XAxis: "x-axis", YAxis: "y-axis",
}));
vi.mock("@/components/fetchJson", () => ({ fetchJson: network.read, postJson: vi.fn() }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/DecisionVisual", () => ({ default: "decision-visual" }));
vi.mock("@/components/ProductExternalDecisionEvidenceCard", () => ({ default: "external-evidence" }));
vi.mock("@/components/ListToolbar", () => ({ default: "list-toolbar" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote-select" }));
vi.mock("@/components/supplier-external-evidence", () => ({ buildSupplierExternalEvidenceBriefs: () => [] }));
vi.mock("@/app/(app)/report/supplier-scorecard/lead-history-tab", () => ({ default: "lead-history" }));
vi.mock("@/app/(app)/report/supplier-scorecard/leadtime-learning-tab", () => ({ default: "lead-learning" }));
vi.mock("@/app/(app)/report/supplier-scorecard/payment-term-tab", () => ({ default: "payment-term" }));
vi.mock("@/components/useListState", () => ({
  useListState: () => ({
    filters: { q: ui.q, windowDays: ui.windowDays }, page: ui.page, pageSize: ui.pageSize, tableSize: "small",
    setFilter: (next: { q?: string; windowDays?: string }) => { Object.assign(ui, next); ui.page = 1; },
    paginationProps: (props: object) => ({ ...props, onChange: (page: number, pageSize: number) => { ui.page = page; ui.pageSize = pageSize; } }),
  }),
}));

type Props = Record<string, unknown> & { children?: ReactNode; extra?: ReactNode; action?: ReactNode; dataView?: ReactNode };
type Element = React.ReactElement<Props>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...[node.props.children, node.props.extra, node.props.action, node.props.dataView].flatMap(elements)];
}
function render(): Element {
  for (let pass = 0; pass < 6; pass += 1) {
    hooks.cursor = 0; hooks.changed = false;
    const tabs = elements(SupplierScorecardClient()).find((node) => node.type === "tabs")!;
    const items = tabs.props.items as { key: string; children: React.ReactElement }[];
    const PriceTab = items.find((item) => item.key === "price")!.children.type as () => Element;
    const tree = PriceTab();
    for (const commit of hooks.layout.splice(0)) commit();
    for (const passive of hooks.passive.splice(0)) passive();
    if (!hooks.changed) return tree;
  }
  throw new Error("Component did not settle");
}
function unmount() {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const visual = (tree = render()) => elements(tree).find((node) => node.type === "decision-visual")!;
const exportAction = (tree = render()) => visual(tree).props.onExport as (() => void) | undefined;
const signal = (index: number) => network.fetch.mock.calls[index][1].signal as AbortSignal;
const ready = async () => { render(); await flush(); return render(); };
function fact() {
  return {
    rows: [], total: 0, supplierSummary: [],
    summary: { asOf: "2026-09-06", comparableSkuCount: 0, comparableSupplierCount: 0, comparableLineCount: 0, inputLineCount: 0, coveragePct: "0", excludedInvalidLineCount: 0, singleSupplierLineCount: 0 },
  };
}
function response(overrides: object = {}) {
  return {
    ok: true, status: 200, headers: new Headers({ "content-type": "text/csv; charset=utf-8" }),
    blob: vi.fn().mockResolvedValue(new Blob(["编码,偏差\nS1,0"])),
    json: vi.fn().mockResolvedValue({}), ...overrides,
  };
}
const anchor = { href: "", download: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() };
const append = vi.fn();
const createAnchor = vi.fn();
const scheduled: { callback: () => void; delay: number }[] = [];

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", network.fetch);
  vi.stubGlobal("document", { createElement: createAnchor, body: { appendChild: append } });
  vi.stubGlobal("window", { setTimeout: (callback: () => void, delay: number) => { scheduled.push({ callback, delay }); return scheduled.length; } });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:price-export");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  Object.assign(ui, { q: "", windowDays: "180", page: 1, pageSize: 20, tab: "price" });
  hooks.cursor = 0; hooks.slots = []; hooks.layout = []; hooks.passive = []; hooks.cleanups.clear(); hooks.changed = false; hooks.writes = 0;
  scheduled.length = 0;
  for (const mock of [network.read, network.fetch, network.error, anchor.click, anchor.remove, append, createAnchor]) mock.mockReset();
  anchor.href = ""; anchor.download = ""; anchor.style.display = "";
  createAnchor.mockReturnValue(anchor);
  network.read.mockResolvedValue(fact());
  network.fetch.mockReturnValue(new Promise(() => {}));
});
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("price variance CSV request lifecycle", () => {
  it("exports the current complete query once despite same-tick duplicate clicks, preserving CSV and filename", async () => {
    ui.q = "EXP"; ui.windowDays = "90"; ui.page = 3;
    const pending = deferred(); network.fetch.mockReturnValueOnce(pending.promise);
    const action = exportAction(await ready())!;
    action(); action();
    expect(network.fetch).toHaveBeenCalledTimes(1);
    const query = new URL(network.fetch.mock.calls[0][0], "https://example.test").searchParams;
    expect(Object.fromEntries(query)).toEqual({ q: "EXP", windowDays: "90", format: "csv" });
    expect(visual().props.exportLabel).toBe("正在导出，请稍候");
    const result = response(); pending.resolve(result); await flush();
    expect(URL.createObjectURL).toHaveBeenCalledWith(await result.blob.mock.results[0].value);
    expect(anchor.download).toBe("供应商价格偏差观察值-2026-09-06.csv");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(visual().props.exportLabel).toBe("导出完整筛选结果（最多 5000 行）");
    expect(scheduled[0].delay).toBe(1_000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    scheduled[0].callback();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:price-export");
  });

  it("does not expose export before facts arrive or while its retained tab is inactive", async () => {
    expect(exportAction(render())).toBeUndefined();
    await flush();
    const oldAction = exportAction(render())!;
    ui.tab = "qc";
    expect(exportAction(render())).toBeUndefined();
    oldAction();
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it.each(["q", "window", "page", "tab"])("cancels an in-flight header read on %s changes and refuses stale callbacks", async (change) => {
    const pending = deferred(); network.fetch.mockReturnValueOnce(pending.promise);
    const oldAction = exportAction(await ready())!; oldAction();
    if (change === "q") ui.q = "new scope";
    else if (change === "window") ui.windowDays = "90";
    else if (change === "page") ui.page = 2;
    else ui.tab = "qc";
    render();
    expect(signal(0).aborted).toBe(true);
    oldAction();
    expect(network.fetch).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(network.error).not.toHaveBeenCalled();
  });

  it("cancels on same-query report refresh without allowing the old CSV to download", async () => {
    const exported = deferred(); network.fetch.mockReturnValueOnce(exported.promise);
    exportAction(await ready())!();
    const refreshed = deferred(); network.read.mockReturnValueOnce(refreshed.promise);
    // Invoke the existing read hook's stable reload, also used by its retry button.
    const loaders = hooks.slots.filter((value): value is { current: () => Promise<void> } => typeof value === "object" && value !== null && "current" in value && typeof value.current === "function");
    expect(loaders).toHaveLength(1);
    void loaders[0].current();
    expect(exportAction(render())).toBeUndefined();
    expect(signal(0).aborted).toBe(true);
    exported.resolve(response()); await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    refreshed.resolve(fact()); await flush();
    expect(exportAction(render())).toBeTypeOf("function");
  });

  it("rechecks ownership after CSV body reading, not only after response headers", async () => {
    const body = deferred<Blob>();
    network.fetch.mockResolvedValueOnce(response({ blob: vi.fn(() => body.promise) }));
    exportAction(await ready())!(); await flush();
    ui.tab = "qc"; render();
    expect(signal(0).aborted).toBe(true);
    body.resolve(new Blob(["old CSV"])); await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(network.error).not.toHaveBeenCalled();
  });

  it("a stale JSON error body cannot notify after a filter change", async () => {
    const body = deferred();
    network.fetch.mockResolvedValueOnce(response({ ok: false, status: 403, json: vi.fn(() => body.promise) }));
    exportAction(await ready())!(); await flush();
    ui.q = "new scope"; render();
    body.resolve({ error: "old permission failure" }); await flush();
    expect(network.error).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("an old rejection/finally cannot unlock or silence a newer export", async () => {
    const old = deferred(), current = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    exportAction(await ready())!();
    ui.q = "new scope"; render(); await flush();
    const action = exportAction(render())!; action();
    old.reject(new Error("stale transport failure")); await flush();
    expect(visual().props.exportLabel).toBe("正在导出，请稍候");
    action();
    expect(network.fetch).toHaveBeenCalledTimes(2);
    expect(signal(1).aborted).toBe(false);
    expect(network.error).not.toHaveBeenCalled();
    current.resolve(response()); await flush();
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(visual().props.exportLabel).toBe("导出完整筛选结果（最多 5000 行）");
  });

  it("unmount cancels pending reads without downloading, notifying, or writing component state", async () => {
    const pending = deferred(); network.fetch.mockReturnValueOnce(pending.promise);
    exportAction(await ready())!(); unmount();
    expect(signal(0).aborted).toBe(true);
    const writes = hooks.writes;
    pending.reject(new Error("detached response")); await flush();
    expect(hooks.writes).toBe(writes);
    expect(network.error).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    { body: { error: "无权查看采购价格" }, expected: "无权查看采购价格" },
    { body: { error: { detail: "private" } }, expected: "导出失败（HTTP 403）" },
    { body: { error: "<html>proxy failure</html>" }, expected: "导出失败（HTTP 403）" },
    { body: { error: "bad\ncontrol" }, expected: "导出失败（HTTP 403）" },
    { body: { error: "x".repeat(501) }, expected: "导出失败（HTTP 403）" },
  ])("only displays safe short server errors: $expected", async ({ body, expected }) => {
    network.fetch.mockResolvedValueOnce(response({ ok: false, status: 403, json: vi.fn().mockResolvedValue(body) }));
    exportAction(await ready())!(); await flush();
    expect(network.error).toHaveBeenCalledExactlyOnceWith(expected);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(visual().props.exportLabel).toBe("导出完整筛选结果（最多 5000 行）");
  });

  it("handles unreadable error JSON safely without an automatic retry", async () => {
    network.fetch.mockResolvedValueOnce(response({ ok: false, status: 502, json: vi.fn().mockRejectedValue(new Error("raw proxy details")) }));
    exportAction(await ready())!(); await flush();
    expect(network.error).toHaveBeenCalledExactlyOnceWith("导出失败（HTTP 502）");
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not save an HTML success response as a CSV file", async () => {
    const invalid = response({ headers: new Headers({ "content-type": "text/html" }) });
    network.fetch.mockResolvedValueOnce(invalid);
    exportAction(await ready())!(); await flush();
    expect(network.error).toHaveBeenCalledExactlyOnceWith("服务器未返回 CSV 文件，请确认登录状态后重试");
    expect(invalid.blob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("uses a safe transport failure and allows only an explicit subsequent attempt", async () => {
    network.fetch.mockRejectedValueOnce(new Error("private URL and transport details"));
    exportAction(await ready())!(); await flush();
    expect(network.error).toHaveBeenCalledExactlyOnceWith("网络连接异常，未能获取导出响应");
    expect(network.fetch).toHaveBeenCalledTimes(1);
    network.fetch.mockResolvedValueOnce(response());
    exportAction(render())!(); await flush();
    expect(network.fetch).toHaveBeenCalledTimes(2);
    expect(anchor.click).toHaveBeenCalledOnce();
  });

  it("body read failure clears its own lock but does not expose raw errors", async () => {
    network.fetch.mockResolvedValueOnce(response({ blob: vi.fn().mockRejectedValue(new Error("private stream details")) }));
    exportAction(await ready())!(); await flush();
    expect(network.error).toHaveBeenCalledExactlyOnceWith("导出文件读取失败，请稍后重试");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(visual().props.exportLabel).toBe("导出完整筛选结果（最多 5000 行）");
  });
});
