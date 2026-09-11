import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExternalSkuRankingCard from "@/app/(app)/report/decision-studio/external-sku-ranking-card";
import SupplierScorecardClient from "@/app/(app)/report/supplier-scorecard/supplier-scorecard-client";
import ClosedLoopClient from "@/app/(app)/report/closed-loop/closed-loop-client";
import AlertsClient, { SpikeTab } from "@/app/(app)/inventory/alerts/alerts-client";
import SystemAlertsClient from "@/app/(app)/alerts/alerts-client";
import { useAlertLookup } from "@/components/useAlertLookup";
import ExportButton, { AsyncExportButton } from "@/components/ExportButton";
import ExportsClient from "@/app/(app)/report/exports/exports-client";

// Real components and callbacks, deferred network responses, no DOM or visual claims.
const hooks = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(), changed: false, writes: 0,
}));
const network = vi.hoisted(() => ({ fetch: vi.fn(), post: vi.fn(), csv: vi.fn() }));
const message = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const breakpoint = vi.hoisted(() => ({ xl: true }));
const lists = vi.hoisted(() => ({
  filters: {} as Record<string, Record<string, string>>,
  pages: {} as Record<string, number>,
}));

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (next: T | ((previous: T) => T)) => {
      const value = typeof next === "function" ? (next as (previous: T) => T)(hooks.slots[index] as T) : next;
      hooks.writes += 1;
      if (!Object.is(hooks.slots[index], value)) hooks.changed = true;
      hooks.slots[index] = value;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useCallback: (callback: unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.slots[index] = { value: callback, deps };
    return (hooks.slots[index] as { value: unknown }).value;
  },
  useMemo: (create: () => unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.slots[index] = { value: create(), deps };
    return (hooks.slots[index] as { value: unknown }).value;
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as readonly unknown[] | undefined;
    if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = deps;
    hooks.effects.push(() => {
      hooks.cleanups.get(index)?.();
      hooks.cleanups.delete(index);
      const cleanup = effect();
      if (cleanup) hooks.cleanups.set(index, cleanup);
    });
  },
  useLayoutEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as readonly unknown[] | undefined;
    if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = deps;
    hooks.effects.push(() => {
      hooks.cleanups.get(index)?.();
      hooks.cleanups.delete(index);
      const cleanup = effect();
      if (cleanup) hooks.cleanups.set(index, cleanup);
    });
  },
}));
vi.mock("antd", () => ({
  App: { useApp: () => ({ message }) },
  Grid: { useBreakpoint: () => breakpoint },
  Alert: "alert", Button: "button", Card: "card", Col: "col", Row: "row", Select: "select",
  Space: "space", Switch: "switch", Statistic: "statistic", Table: "table", Tag: "tag", Popconfirm: "popconfirm",
  Progress: "progress", Segmented: "segmented", Tabs: "tabs", Tooltip: "tooltip", Pagination: "pagination", Empty: "empty", Spin: "spin",
  Typography: { Text: "text", Paragraph: "paragraph", Title: "title" },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@ant-design/icons", () => ({ ReloadOutlined: "reload-icon", DownloadOutlined: "download-icon", CloudDownloadOutlined: "cloud-download-icon" }));
vi.mock("recharts", () => ({
  Bar: "bar", BarChart: "bar-chart", CartesianGrid: "grid", Legend: "legend", Cell: "cell",
  ResponsiveContainer: "chart-container", Tooltip: "chart-tooltip", XAxis: "x-axis", YAxis: "y-axis",
}));
vi.mock("@/components/fetchJson", async (original) => ({ ...await original<typeof import("@/components/fetchJson")>(), fetchJson: network.fetch, postJson: network.post }));
vi.mock("@/components/exportCsv", () => ({ exportCsv: network.csv }));
vi.mock("@/components/format", () => ({ formatQty: String }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/SkuHoverCard", () => ({ default: "sku-hover" }));
vi.mock("@/components/DecisionVisual", () => ({ default: "decision-visual" }));
vi.mock("@/components/ProductExternalDecisionEvidenceCard", () => ({ default: "external-evidence" }));
vi.mock("@/components/ListToolbar", () => ({ default: "list-toolbar" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("@/components/AlertCloseModal", () => ({ default: "alert-close" }));
vi.mock("@/components/AlertEvidence", () => ({ default: "alert-evidence", ackText: () => "未确认" }));
vi.mock("@/components/CaliberNote", () => ({ default: "caliber-note" }));
vi.mock("@/components/useMe", () => ({ useMe: () => ({ id: 1, roles: ["admin"] }), hasAnyRole: () => true }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote-select" }));
vi.mock("@/components/supplier-external-evidence", () => ({ buildSupplierExternalEvidenceBriefs: () => [] }));
vi.mock("@/app/(app)/report/supplier-scorecard/lead-history-tab", () => ({ default: "lead-history" }));
vi.mock("@/app/(app)/report/supplier-scorecard/leadtime-learning-tab", () => ({ default: "lead-learning" }));
vi.mock("@/app/(app)/report/supplier-scorecard/payment-term-tab", () => ({ default: "payment-term" }));
vi.mock("@/components/useListState", () => ({
  useListState: ({ paramPrefix: prefix, key, defaults }: { paramPrefix?: string; key?: string; defaults: Record<string, string> }) => {
    const paramPrefix = prefix ?? key ?? "";
    lists.filters[paramPrefix] ??= defaults;
    const setPage = (page: number) => { lists.pages[paramPrefix] = page; };
    return {
      filters: lists.filters[paramPrefix], page: lists.pages[paramPrefix] ?? 1, pageSize: 20, tableSize: "small",
      setFilter: (next: Record<string, string>) => { lists.filters[paramPrefix] = { ...lists.filters[paramPrefix], ...next }; setPage(1); },
      setPage, paginationProps: (props: object) => ({ ...props, onChange: setPage }),
      queryString: () => new URLSearchParams({ ...lists.filters[paramPrefix], page: String(lists.pages[paramPrefix] ?? 1) }).toString(),
    };
  },
}));

type Props = Record<string, unknown> & { children?: ReactNode; extra?: ReactNode; description?: ReactNode; action?: ReactNode; dataView?: ReactNode; primaryActions?: ReactNode };
type Element = React.ReactElement<Props>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...[node.props.children, node.props.extra, node.props.description, node.props.action, node.props.dataView, node.props.primaryActions].flatMap(elements)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render(component: () => React.ReactElement): React.ReactElement {
  for (let pass = 0; pass < 5; pass += 1) {
    hooks.cursor = 0;
    hooks.changed = false;
    const tree = component();
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree;
  }
  throw new Error("Component did not settle");
}
function unmount() {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };
const table = (tree: ReactNode) => elements(tree).filter((node) => node.type === "table").at(-1)!;
const button = (tree: ReactNode, label: string) => elements(tree).find((node) => node.type === "button" && text(node) === label)!;
const click = (element: Element) => (element.props.onClick as () => void)();
const signal = (index: number) => network.fetch.mock.calls[index][1].signal as AbortSignal;
const rows = (tree: ReactNode) => table(tree).props.dataSource;

describe("system alert list loading evidence", () => {
  const data = { rows: [{ id: 1, category: "sales_spike", title: "old alert", status: "open", detail: null, createdAt: "2026-09-01" }], total: 21, page: 1, pageSize: 20 };
  it("removes old rows during refresh and keeps failure visible until explicit retry", async () => {
    const pending = deferred();
    network.fetch.mockResolvedValueOnce(data).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...data, rows: [] });
    render(SystemAlertsClient); await flush();
    expect(rows(render(SystemAlertsClient))).toEqual(data.rows);
    click(button(render(SystemAlertsClient), "刷新"));
    expect(rows(render(SystemAlertsClient))).toEqual([]);
    pending.reject(new Error("网络失败")); await flush();
    const failed = render(SystemAlertsClient);
    expect(rows(failed)).toEqual([]);
    const error = elements(failed).find(n => n.type === "load-error")!;
    expect(error.props.error).toBe("网络失败");
    (error.props.onRetry as () => void)(); render(SystemAlertsClient); await flush();
    expect(rows(render(SystemAlertsClient))).toEqual([]);
    expect(elements(render(SystemAlertsClient)).find(n => n.type === "load-error")?.props.error).toBeNull();
  });
  it("drops stale responses after a filter change and aborts on unmount", async () => {
    const old = deferred(), next = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    render(SystemAlertsClient);
    lists.filters["system-alerts"].category = "doc_aging";
    render(SystemAlertsClient);
    expect(signal(0).aborted).toBe(true);
    next.resolve({ ...data, rows: [{ ...data.rows[0], id: 2, category: "doc_aging" }] }); await flush();
    old.resolve(data); await flush();
    expect(rows(render(SystemAlertsClient))).toEqual([{ ...data.rows[0], id: 2, category: "doc_aging" }]);
    unmount(); expect(signal(1).aborted).toBe(true);
  });
  it("hides old-query facts before the replacement effect runs", async () => {
    network.fetch.mockResolvedValueOnce(data).mockReturnValueOnce(deferred().promise);
    render(SystemAlertsClient); await flush(); render(SystemAlertsClient);
    lists.filters["system-alerts"] = { ...lists.filters["system-alerts"], severity: "critical" };
    hooks.cursor = 0;
    const beforeEffect = SystemAlertsClient();
    expect(rows(beforeEffect)).toEqual([]);
    expect(table(beforeEffect).props.loading).toBe(true);
    expect(elements(beforeEffect).some(n => n.type === "pagination")).toBe(false);
    render(SystemAlertsClient);
  });
  it("does not let a superseded failure end the new read or hide its failure", async () => {
    const old = deferred(), current = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    render(SystemAlertsClient);
    lists.filters["system-alerts"].category = "doc_aging";
    render(SystemAlertsClient);
    old.reject(new Error("旧错误")); await flush();
    expect(table(render(SystemAlertsClient)).props.loading).toBe(true);
    current.reject(new Error("当前错误")); await flush();
    expect(elements(render(SystemAlertsClient)).find(n => n.type === "load-error")?.props.error).toBe("当前错误");
  });
  it("sends desktop sorting to the server and resets pagination rather than sorting a page locally", async () => {
    network.fetch.mockResolvedValue(data);
    render(SystemAlertsClient); await flush();
    lists.pages["system-alerts"] = 4;
    const tree = render(SystemAlertsClient);
    const columns = table(tree).props.columns as { dataIndex?: string; sorter?: unknown }[];
    expect(columns.find(c => c.dataIndex === "createdAt")?.sorter).toBe(true);
    (table(tree).props.onChange as (...args: unknown[]) => void)({}, {}, { field: "createdAt", order: "ascend" }, { action: "sort" });
    render(SystemAlertsClient);
    expect(lists.pages["system-alerts"]).toBe(1);
    expect(network.fetch.mock.lastCall?.[0]).toContain("sort=createdAt&order=asc");
  });
});
const external = () => ExternalSkuRankingCard({ active: true });
const platformSelect = (tree: ReactNode) => elements(tree).find((node) => node.type === "select" && ["all", "tmall", "pdd"].includes(String(node.props.value)))!;
const selectPlatform = (tree: ReactNode, platform: string) => (platformSelect(tree).props.onChange as (value: string) => void)(platform);
function supplierTab(key: string): () => React.ReactElement {
  const tabs = elements(SupplierScorecardClient()).find((node) => node.type === "tabs")!;
  const items = tabs.props.items as { key: string; children: React.ReactElement }[];
  return items.find((item) => item.key === key)!.children.type as () => React.ReactElement;
}
function ranking(name: string) {
  return {
    state: "ready", totalRows: 1, anchorDate: "2026-09-05", sourceAsOf: "2026-09-05", pddSourceAsOf: null,
    internalMonths: ["2026-08"], brands: ["EXP"], gate: "仅供观察", limitations: ["不可自动定量"],
    coverage: { platformSkus: 2, mappedPlatformSkus: 1, bundlePlatformSkus: 0, pddObservedDays30: 0, pddWindowComplete30: false },
    rows: [{ skuId: 1, name, code: "EXP-1", rank: 1, brand: "EXP", net30: 30, net90: 90, tmallNet30: 30, pddNet30: 0, tmallNet90: 90, pddNet90: 0, lastSoldDate: null, activeDays90: 2, platformSkus: 1, internal3m: null }],
  };
}
function scoreData(name: string) {
  return {
    rows: [{ supplierId: 1, code: "S1", name, grade: "A", currentLevel: "B", suggestLevelChange: true, breakdown: [], confidence: "high" }],
    total: 1, minSamples: 3, promiseHistory: { trusted: 1, backfilled: 0, missing: 0 }, supportingObservations: [],
    summary: { suppliers: 1, rated: 1, suggestChanges: 1, avgOnTimeRate: null, avgOnTimeRateCurrent: null, windowDays: 180, legacyQualityCases: 0 },
  };
}
function qcData(name: string) {
  return { rows: [{ supplierId: 1, code: "S1", name, month: "2026-08", passQty: 10, reworkQty: 0, concessionQty: 0, scrapQty: 0, pendingQty: 0 }], months: ["2026-08"], totals: { batches: 1, passRate: 1, concessionRate: 0, scrapRate: 0 } };
}
function priceData(name: string) {
  return { rows: [{ key: "1:1", supplierId: 1, supplierName: name }], total: 1, supplierSummary: [], summary: { asOf: "2026-09-05", comparableSkuCount: 1, comparableSupplierCount: 1, comparableLineCount: 2, inputLineCount: 2, coveragePct: "100", excludedInvalidLineCount: 0, singleSupplierLineCount: 0 } };
}

beforeEach(() => {
  breakpoint.xl = true;
  vi.stubGlobal("React", React); // Scoped classic JSX transform, no inherited globals.
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.cleanups.clear(); hooks.changed = false; hooks.writes = 0;
  lists.filters = {}; lists.pages = {};
  for (const mock of [network.fetch, network.post, network.csv, message.error, message.success]) mock.mockReset();
  network.fetch.mockReturnValue(new Promise(() => {}));
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("export task reading and recovery", () => {
  const done = { id: 17, kind: "inventory-alerts", kindLabel: "库存预警", status: "done", rowCount: 5002,
    requestedByName: "计划员", createdAt: "2026-09-08T07:00:00Z", finishedAt: "2026-09-08T07:01:00Z", error: null };
  it("withdraws old download actions on explicit refresh; failure persists until retry", async () => {
    const pending = deferred();
    network.fetch.mockResolvedValueOnce({ rows: [done] }).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ rows: [] });
    render(ExportsClient); await flush();
    expect(rows(render(ExportsClient))).toEqual([done]);
    click(button(render(ExportsClient), "刷新"));
    expect(rows(render(ExportsClient))).toEqual([]);
    pending.reject(new Error("任务服务暂不可用")); await flush();
    const error = elements(render(ExportsClient)).find(n => n.type === "load-error")!;
    expect(error.props.error).toBe("任务服务暂不可用");
    (error.props.onRetry as () => void)(); render(ExportsClient); await flush();
    expect(rows(render(ExportsClient))).toEqual([]);
    expect(elements(render(ExportsClient)).find(n => n.type === "load-error")?.props.error).toBeNull();
  });
  it("polls only after a settled read, labels previous facts, and stops on timeout without overlapping reads", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred(), active = { ...done, id: 18, status: "running", rowCount: null };
      network.fetch.mockResolvedValueOnce({ rows: [done, active] }).mockReturnValueOnce(pending.promise);
      render(ExportsClient); await flush(); render(ExportsClient);
      await vi.advanceTimersByTimeAsync(5000); render(ExportsClient);
      expect(network.fetch).toHaveBeenCalledTimes(2);
      expect(rows(render(ExportsClient))).toEqual([done, active]);
      expect(text(render(ExportsClient))).toContain("上次成功读取");
      await vi.advanceTimersByTimeAsync(10000); render(ExportsClient);
      expect(network.fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000); render(ExportsClient);
      expect(signal(1).aborted).toBe(true);
      expect(rows(render(ExportsClient))).toEqual([]);
      expect(elements(render(ExportsClient)).find(n => n.type === "load-error")?.props.error).toContain("超时");
      pending.resolve({ rows: [done] }); await flush();
      await vi.advanceTimersByTimeAsync(30000); render(ExportsClient);
      expect(network.fetch).toHaveBeenCalledTimes(2); expect(rows(render(ExportsClient))).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it("aborts on unmount and rejects late results without state writes", async () => {
    const pending = deferred(); network.fetch.mockReturnValue(pending.promise);
    render(ExportsClient); unmount();
    expect(signal(0).aborted).toBe(true);
    const writes = hooks.writes; pending.resolve({ rows: [done] }); await flush(); expect(hooks.writes).toBe(writes);
  });
  it("uses the shared download lifecycle and makes failure evidence readable without hover", async () => {
    network.fetch.mockResolvedValue({ rows: [done] }); render(ExportsClient); await flush();
    const tree = render(ExportsClient);
    const columns = table(tree).props.columns as { key?: string; render?: (v: unknown, row: typeof done) => ReactNode }[];
    const action = columns.find(c => c.key === "action")!.render!(null, done);
    expect(elements(action).find(n => n.type === ExportButton)?.props.href).toBe("/api/export/jobs/17/download");
    const status = columns.find(c => c.key === "status")!.render!(null, { ...done, status: "failed", error: "权限已变化，请重新导出" } as unknown as typeof done);
    expect(text(status)).toContain("权限已变化，请重新导出");
    expect(elements(status).some(n => n.type === "tooltip")).toBe(false);
    expect(text(tree)).toContain("最新 100 个任务");
  });
});

describe("shared CSV export lifecycle", () => {
  let href: string;
  const component = () => ExportButton({ href });
  beforeEach(() => { href = "/api/export/inventory-alerts?q=first"; });

  it("rejects duplicate clicks synchronously and leaves an async receipt without opening a popup", async () => {
    const pending = deferred(), fetch = vi.fn().mockReturnValue(pending.promise), open = vi.fn();
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("window", { open });
    const tree = render(component); click(button(tree, "导出 CSV")); click(button(tree, "导出 CSV"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(button(render(component), "导出 CSV").props["aria-busy"]).toBe(true);
    pending.resolve(new Response(JSON.stringify({ jobId: 12, message: "已创建任务" }), { status: 202 })); await flush();
    const done = render(component);
    expect(text(done)).toContain("任务 #12"); expect(text(done)).toContain("查看导出任务");
    expect(button(done, "导出 CSV").props["aria-busy"]).toBe(false); expect(open).not.toHaveBeenCalled();
  });

  it("stop waiting aborts the request and ignores a late async receipt without claiming job cancellation", async () => {
    const pending = deferred(), fetch = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal("fetch", fetch);
    click(button(render(component), "导出 CSV")); click(button(render(component), "停止等待"));
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    pending.resolve(new Response(JSON.stringify({ jobId: 99 }), { status: 202 })); await flush();
    const done = text(render(component)); expect(done).toContain("不会取消已创建的后台任务"); expect(done).not.toContain("#99");
  });

  it("filter changes and unmount abort stale reads and cannot overwrite current feedback", async () => {
    const old = deferred(), next = deferred(), fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise); vi.stubGlobal("fetch", fetch);
    click(button(render(component), "导出 CSV")); href = "/api/export/inventory-alerts?q=second"; render(component);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    click(button(render(component), "导出 CSV"));
    old.resolve(new Response(JSON.stringify({ jobId: 88 }), { status: 202 })); await flush();
    expect(text(render(component))).not.toContain("#88");
    unmount(); expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
    const writes = hooks.writes; next.reject(new Error("late failure")); await flush(); expect(hooks.writes).toBe(writes);
  });

  it("30-second timeout remains visible, aborts, and never automatically submits a second request", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockReturnValue(deferred().promise); vi.stubGlobal("fetch", fetch);
      click(button(render(component), "导出 CSV")); await vi.advanceTimersByTimeAsync(30000);
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(fetch).toHaveBeenCalledOnce();
      expect(text(render(component))).toContain("后台任务可能已创建");
      expect(button(render(component), "导出 CSV").props["aria-busy"]).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("HTML login response is not downloaded as CSV; explicit retry can recover", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 13 }), { status: 202 })); vi.stubGlobal("fetch", fetch);
    click(button(render(component), "导出 CSV")); await flush();
    expect(text(render(component))).toContain("未收到CSV文件");
    click(button(render(component), "导出 CSV")); await flush();
    expect(text(render(component))).toContain("任务 #13"); expect(text(render(component))).not.toContain("未收到CSV文件");
  });

  it("CSV body finishing after cancellation cannot start a download", async () => {
    const body = deferred(), blob = vi.fn().mockReturnValue(body.promise), create = vi.fn();
    vi.stubGlobal("document", { createElement: create });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "Content-Type": "text/csv" }), blob }));
    click(button(render(component), "导出 CSV")); await flush(); expect(blob).toHaveBeenCalledOnce();
    click(button(render(component), "停止等待")); body.resolve(new Blob(["CSV"])); await flush();
    expect(create).not.toHaveBeenCalled();
  });

  it("existing-file download failures stay in-page and do not claim a new job may exist", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "生成权限已变化，请重新导出" }), { status: 409 }));
    const open = vi.fn(); vi.stubGlobal("fetch", fetch); vi.stubGlobal("window", { open });
    const download = () => ExportButton({ href: "/api/export/jobs/17/download", label: "下载 #17", mode: "download" });
    click(button(render(download), "下载 #17")); await flush();
    expect(text(render(download))).toContain("生成权限已变化，请重新导出");
    expect(text(render(download))).not.toContain("核对导出任务");
    expect(open).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });

  it("stopping an existing download offers download retry, not duplicate task creation", () => {
    const fetch = vi.fn().mockReturnValue(deferred().promise); vi.stubGlobal("fetch", fetch);
    const download = () => ExportButton({ href: "/api/export/jobs/17/download", label: "下载 #17", mode: "download" });
    click(button(render(download), "下载 #17")); click(button(render(download), "停止等待"));
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(text(render(download))).toContain("无需创建新任务");
    expect(text(render(download))).not.toContain("查看导出任务");
    click(button(render(download), "下载 #17")); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ error: "<html>proxy secret</html>" }, { error: { secret: "private" } }, { error: "x".repeat(501) }])("does not echo an unsafe server download error: %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 502 })));
    const download = () => ExportButton({ href: "/api/export/jobs/17/download", label: "下载 #17", mode: "download" });
    click(button(render(download), "下载 #17")); await flush();
    expect(text(render(download))).toBe("下载 #17下载失败（502）");
  });
});

describe("主动异步导出共用有界交互", () => {
  let q = "old";
  const component = () => {
    const tree = AsyncExportButton({ kind: "risk", params: { q } });
    return tree.type === ExportButton ? ExportButton(tree.props) : tree;
  };
  beforeEach(() => {
    q = "old"; vi.stubGlobal("window", { open: vi.fn() });
    // Let the retired postJson implementation reach the same transport, so the
    // negative control measures behavior rather than a different helper name.
    network.post.mockImplementation(async (url: string, body: unknown) => (await fetch(url, { method: "POST", body: JSON.stringify(body) })).json());
  });

  it("one POST per active click pair, with exact filters and a persistent receipt instead of a popup", async () => {
    const response = deferred(); const fetch = vi.fn().mockReturnValue(response.promise); vi.stubGlobal("fetch", fetch);
    const start = button(render(component), "转异步导出"); click(start); click(start);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("/api/export/jobs");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ kind: "risk", params: { q: "old" } }) });
    response.resolve(new Response(JSON.stringify({ job: { id: 21 } }), { status: 201 })); await flush();
    expect(text(render(component))).toContain("任务 #21");
    expect(text(render(component))).toContain("查看导出任务");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("stop waiting aborts the request without claiming to cancel an already-created job", async () => {
    const response = deferred(); const fetch = vi.fn().mockReturnValue(response.promise); vi.stubGlobal("fetch", fetch);
    click(button(render(component), "转异步导出")); click(button(render(component), "停止等待"));
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify({ job: { id: 22 } }), { status: 201 })); await flush();
    expect(text(render(component))).toContain("不会取消已创建"); expect(text(render(component))).not.toContain("任务 #22");
  });

  it("changing filters cancels stale POST receipts, while equal recreated params do not abort", async () => {
    const response = deferred(); const fetch = vi.fn().mockReturnValue(response.promise); vi.stubGlobal("fetch", fetch);
    click(button(render(component), "转异步导出")); render(component);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    q = "new"; render(component); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify({ job: { id: 23 } }), { status: 201 })); await flush();
    expect(text(render(component))).not.toContain("任务 #23");
  });

  it("30-second POST timeout is visible, aborts and never retries automatically", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockReturnValue(deferred().promise); vi.stubGlobal("fetch", fetch);
      click(button(render(component), "转异步导出")); await vi.advanceTimersByTimeAsync(30000);
      expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
      expect(text(render(component))).toContain("后台任务可能已创建");
    } finally { vi.useRealTimers(); }
  });

  it("safe 403 reason remains visible; explicit retry clears it and accepts a valid receipt", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "当前角色不能导出" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: 24 } }), { status: 201 })); vi.stubGlobal("fetch", fetch);
    click(button(render(component), "转异步导出")); await flush(); expect(text(render(component))).toContain("当前角色不能导出");
    click(button(render(component), "转异步导出")); await flush();
    expect(text(render(component))).toContain("任务 #24"); expect(text(render(component))).not.toContain("当前角色不能导出");
  });

  it.each([{ job: { id: "25" } }, { job: { id: 0 } }, { jobId: 25 }])("invalid POST receipt is not treated as successful: %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 201 })));
    click(button(render(component), "转异步导出")); await flush();
    expect(text(render(component))).toContain("回执不完整"); expect(text(render(component))).not.toContain("任务 #");
  });

  it("leaving the page aborts POST; a late response cannot write state or open a new tab", async () => {
    const response = deferred(); const fetch = vi.fn().mockReturnValue(response.promise); vi.stubGlobal("fetch", fetch);
    click(button(render(component), "转异步导出")); unmount(); const writes = hooks.writes;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify({ job: { id: 26 } }), { status: 201 })); await flush();
    expect(hooks.writes).toBe(writes); expect(window.open).not.toHaveBeenCalled();
  });

  it("a malformed HTML receipt is not echoed as a raw parser error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>proxy secret</html>", { status: 201 })));
    click(button(render(component), "转异步导出")); await flush();
    expect(text(render(component))).toContain("回执不完整"); expect(text(render(component))).not.toContain("proxy secret");
  });
});

function closedLoopData(name: string) {
  return {
    rows: [{ id: 1, docNo: name, createdAt: "2026-09-01T00:00:00Z", lineCount: 1, source: "replenish" }],
    total: 21, accuracy: null, suppression: null,
    summary: { total: 21, adopted: 0, pending: 21, rejected: 0, deleted: 0, declined: 0, adoptRate: 0, deliveredRate: null },
  };
}

function spikeData(code: string) {
  return {
    state: "ready", q: "", currentEvidence: true, anchorDate: "2026-09-06", hitCount: 1, unmappedCount: 0,
    params: { consecutiveDays: 3, baselineDays: 7, risePct: 50, minBaseQty: 10 },
    coverage: { evaluatedItems: 1, incompleteItems: 0, platformSeries: 1, mappedSeries: 1, systemSkus: 1 }, limitations: [],
    hits: [{ kind: "sku", skuId: 1, code, name: code, shopName: "店铺", days: [], baseline: "10", threshold: "15", risePct: "100" }],
    unmappedHits: [],
  };
}
const spikeRows = (tree: ReactNode) => elements(tree).find((n) => n.type === "table")!.props.dataSource;

describe("exact alert lookup lifecycle", () => {
  let keys: string[] | null;
  const LookupProbe = () => React.createElement("lookup", useAlertLookup("inventory_cover", keys));
  const state = () => render(LookupProbe).props as ReturnType<typeof useAlertLookup>;
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); return state(); };
  const result = (n: number) => ({ rows: [{ id: n, dedupeKey: `inventory_cover:${n}`, status: "open" }], total: 1, unackedTotal: 600 });
  beforeEach(() => { keys = ["inventory_cover:1"]; });
  it("withdraws previous keys before effects and ignores cancelled late replies", async () => {
    const old = deferred(), current = deferred(); network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    state(); keys = ["inventory_cover:2"];
    hooks.cursor = 0; expect(LookupProbe().props.byKey).toEqual({}); state(); expect(signal(0).aborted).toBe(true);
    current.resolve(result(2)); await settle(); old.resolve(result(1)); await settle();
    expect(Object.keys(state().byKey)).toEqual(["inventory_cover:2"]);
    expect(state().unacked).toBe(600);
  });
  it("explicit retry withdraws old actions immediately, then failure stays unknown instead of empty-success", async () => {
    network.fetch.mockResolvedValueOnce(result(1)); state(); await settle(); expect(state().phase).toBe("success");
    network.fetch.mockRejectedValueOnce(new Error("network failure")); state().retry();
    hooks.cursor = 0; expect(LookupProbe().props.byKey).toEqual({}); state(); await settle();
    expect(state()).toMatchObject({ phase: "error", byKey: {}, unacked: null });
    network.fetch.mockResolvedValueOnce({ rows: [], total: 0, unackedTotal: 0 }); state().retry(); state(); await settle();
    expect(state()).toMatchObject({ phase: "success", byKey: {}, unacked: 0 });
  });
  it("null source cancels lookup without presenting stale actions or a zero count", async () => {
    const pending = deferred(); network.fetch.mockReturnValueOnce(pending.promise); state(); keys = null; state();
    expect(signal(0).aborted).toBe(true); pending.resolve(result(1)); await settle();
    expect(state()).toMatchObject({ phase: "idle", byKey: {}, unacked: null });
  });
  it("timeout is retryable and its late reply cannot replace the retry", async () => {
    vi.useFakeTimers();
    try {
      const old = deferred(); network.fetch.mockReturnValueOnce(old.promise); state();
      await vi.advanceTimersByTimeAsync(15_000); await settle(); expect(state().error).toContain("超时");
      network.fetch.mockResolvedValueOnce(result(1)); state().retry(); state(); await settle();
      old.resolve({ rows: [], total: 0, unackedTotal: 0 }); await settle(); expect(state().unacked).toBe(600);
    } finally { vi.useRealTimers(); }
  });
});

describe("告警状态与行动不被固定列遮挡", () => {
  it.each(["cover", "spike"])("%s刷新/重算在忙碌与失败后保留稳定名称", async (kind) => {
    const pending = deferred(); network.fetch.mockReturnValue(pending.promise);
    const items = elements(AlertsClient()).find(n => n.type === "tabs")!.props.items as { key: string; children: React.ReactElement }[];
    const component = items.find(item => item.key === kind)!.children.type as () => React.ReactElement;
    const subject = kind === "cover" ? "库存预警" : "爆单预警";
    const busy = render(component);
    for (const action of ["刷新", "重算"]) {
      expect(button(busy, action).props["aria-label"]).toBe(action + subject);
      expect(button(busy, action).props["aria-busy"]).toBe(true);
    }
    pending.reject(new Error("合成读取失败")); await flush();
    for (const action of ["刷新", "重算"]) {
      expect(button(render(component), action).props["aria-label"]).toBe(action + subject);
      expect(button(render(component), action).props["aria-busy"]).toBe(false);
    }
  });
  it.each(["cover", "spike"])("%s把知悉状态与跳转放入同一个右侧固定列", (kind) => {
    network.fetch.mockReturnValue(deferred().promise);
    const items = elements(AlertsClient()).find(n => n.type === "tabs")!.props.items as { key: string; children: React.ReactElement }[];
    const component = items.find(item => item.key === kind)!.children.type as () => React.ReactElement;
    const columns = table(render(component)).props.columns as { key?: string; fixed?: string; render?: (value: null, row: object) => ReactNode }[];
    expect(columns.some(column => column.key === "ack")).toBe(false);
    const action = columns.find(column => column.key === "a")!;
    expect(action.fixed).toBe("right");
    const content = action.render!(null, { skuId: 5, kind: "sku", shopName: "QA", href: "/report/auto-replenish?skuIds=5" });
    expect(elements(content).some(n => typeof n.props.onAck === "function" && n.props.phase === "idle")).toBe(true);
    expect(elements(content).filter(n => isValidElement(n)).length).toBeGreaterThan(2);
  });
});

describe("爆单当前查询与证据状态", () => {
  it("keeps one close target outside rows while responsive columns rebuild", async () => {
    const alert = { id: 506, dedupeKey: "sales_spike:sku:1", status: "open", ownerRole: "pmc" };
    network.fetch.mockImplementation((url: string) => Promise.resolve(url.startsWith("/api/alerts?")
      ? { rows: [alert], total: 1, unackedTotal: 1 } : spikeData("responsive")));
    for (let n = 0; n < 5; n++) { render(SpikeTab); await flush(); }
    const tree = render(SpikeTab);
    const mapped = elements(tree).find(n => n.type === "table")!;
    const expandable = mapped.props.expandable as { expandedRowRender: (row: object) => React.ReactElement<{ onRequestClose: () => void }> };
    const detail = expandable.expandedRowRender(spikeData("responsive").hits[0]);
    expect(detail.props.onRequestClose).toBeTypeOf("function");
    detail.props.onRequestClose();
    for (const xl of [false, true, false]) {
      breakpoint.xl = xl;
      const dialogs = elements(render(SpikeTab)).filter(n => n.type === "alert-close");
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0].props).toMatchObject({ open: true, alertId: 506 });
    }
    const dialog = elements(render(SpikeTab)).find(n => n.type === "alert-close")!;
    (dialog.props.onCancel as () => void)();
    expect(elements(render(SpikeTab)).find(n => n.type === "alert-close")?.props.open).toBe(false);
  });

  it("说明区不把已知悉或缺失证据承诺为自动关闭", () => {
    const note = elements(render(AlertsClient)).find((n) => n.type === "caliber-note")!;
    const detail = text(note.props.detail as ReactNode);
    expect(detail).toContain("已知悉只留审计不改状态");
    expect(detail).toContain("完整且符合 T+1 时效");
    expect(detail).toContain("距最后命中满 3 天");
    expect(detail).not.toContain("连续 3 天不再命中");
  });

  it("缺证据显示破折号与无法判定，不伪装为零爆单", async () => {
    network.fetch.mockImplementation((url: string) => Promise.resolve(url.startsWith("/api/alerts?") ? { rows: [] } : {
      ...spikeData("unknown"), state: "insufficient", currentEvidence: false, hits: [], hitCount: 0,
      coverage: { ...spikeData("").coverage, evaluatedItems: 0, incompleteItems: 1 },
    }));
    const loading = render(SpikeTab);
    expect((elements(loading).find((n) => n.type === "table")!.props.locale as { emptyText: string }).emptyText).toContain("正在加载");
    await flush();
    const tree = render(SpikeTab);
    expect(elements(tree).filter((n) => n.type === "statistic").slice(0, 2).map((n) => n.props.value)).toEqual(["—", "—"]);
    expect((elements(tree).find((n) => n.type === "table")!.props.locale as { emptyText: string }).emptyText).toContain("无法判定");
    expect(elements(tree).find((n) => n.type === "alert")?.props.type).toBe("warning");
    expect(text(elements(tree).find((n) => n.type === "alert")?.props.description as ReactNode)).toContain("不会自动关闭旧告警");
  });

  it("切换查询取消旧请求，迟到成功不能覆盖新结果", async () => {
    const old = deferred(), latest = deferred();
    network.fetch.mockImplementation((url: string) => url.startsWith("/api/alerts?") ? Promise.resolve({ rows: [] }) : url.includes("q=new") ? latest.promise : old.promise);
    render(SpikeTab); await flush();
    lists.filters.spike = { q: "new" };
    render(SpikeTab);
    const oldCall = network.fetch.mock.calls.find(([url]) => String(url).startsWith("/api/report/sales-spike?") && !String(url).includes("q=new"))!;
    expect((oldCall[1].signal as AbortSignal).aborted).toBe(true);
    latest.resolve(spikeData("new")); await flush();
    old.resolve(spikeData("old")); await flush();
    expect(spikeRows(render(SpikeTab))).toEqual(spikeData("new").hits);
  });

  it("迟到错误不结束新查询加载，也不覆盖当前失败", async () => {
    const old = deferred(), latest = deferred();
    network.fetch.mockImplementation((url: string) => url.startsWith("/api/alerts?") ? Promise.resolve({ rows: [] }) : url.includes("q=new") ? latest.promise : old.promise);
    render(SpikeTab); await flush();
    lists.filters.spike = { q: "new" }; render(SpikeTab);
    old.reject(new Error("过期查询失败")); await flush();
    const pending = render(SpikeTab);
    expect(elements(pending).find((n) => n.type === "table")!.props.loading).toBe(true);
    expect(elements(pending).find((n) => n.type === "load-error")?.props.error).toBeNull();
    latest.reject(new Error("当前查询失败")); await flush();
    expect(elements(render(SpikeTab)).find((n) => n.type === "load-error")?.props.error).toBe("当前查询失败");
  });

  it("刷新撤下旧数据和导出；失败持续可见，显式重试恢复", async () => {
    const pending = deferred();
    let n = 0;
    network.fetch.mockImplementation((url: string) => url.startsWith("/api/alerts?") ? Promise.resolve({ rows: [] }) : ++n === 1 ? Promise.resolve(spikeData("old")) : n === 2 ? pending.promise : Promise.resolve(spikeData("retry")));
    render(SpikeTab); await flush();
    click(button(render(SpikeTab), "刷新"));
    const loading = render(SpikeTab);
    expect(spikeRows(loading)).toEqual([]);
    expect(elements(loading).find((e) => e.type === "list-toolbar")?.props.onExport).toBeUndefined();
    pending.reject(new Error("当前窗口读取失败")); await flush();
    const failed = render(SpikeTab);
    const error = elements(failed).find((e) => e.type === "load-error")!;
    expect(error.props.error).toBe("当前窗口读取失败");
    (error.props.onRetry as () => void)(); await flush();
    expect(spikeRows(render(SpikeTab))).toEqual(spikeData("retry").hits);
  });
});

describe("closed-loop current-page facts", () => {
  it("ignores an old page success even if transport resolves after cancellation", async () => {
    const old = deferred(), latest = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(ClosedLoopClient);
    lists.pages["closed-loop"] = 2;
    render(ClosedLoopClient);
    expect(network.fetch.mock.calls[1][0]).toContain("page=2&");
    latest.resolve(closedLoopData("new")); await flush();
    old.resolve(closedLoopData("old")); await flush();
    expect(rows(render(ClosedLoopClient))).toEqual(closedLoopData("new").rows);
    expect(signal(0).aborted).toBe(true);
  });

  it("old errors neither end the new loading state nor replace the current error", async () => {
    const old = deferred(), latest = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(ClosedLoopClient);
    lists.pages["closed-loop"] = 2;
    render(ClosedLoopClient);
    old.reject(new Error("old failure")); await flush();
    const pending = render(ClosedLoopClient);
    expect(table(pending).props.loading).toBe(true);
    expect(message.error).not.toHaveBeenCalled();
    latest.reject(new Error("current failure")); await flush();
    const failed = render(ClosedLoopClient);
    expect(elements(failed).find((n) => n.type === "load-error")?.props.error).toBe("current failure");
    expect(message.error).toHaveBeenCalledExactlyOnceWith("current failure");
  });

  it("clears old page facts and KPIs while loading; explicit retry preserves real zero and unknown ratios", async () => {
    const next = deferred();
    network.fetch.mockResolvedValueOnce(closedLoopData("old")).mockReturnValueOnce(next.promise).mockResolvedValueOnce(closedLoopData("retry"));
    render(ClosedLoopClient); await flush();
    expect(rows(render(ClosedLoopClient))).toEqual(closedLoopData("old").rows);
    lists.pages["closed-loop"] = 2;
    const pending = render(ClosedLoopClient);
    expect(rows(pending)).toEqual([]);
    expect(elements(pending).filter((n) => n.type === "statistic").map((n) => n.props.value)).toEqual(Array(7).fill("—"));
    next.reject(new Error("unavailable")); await flush();
    const failed = render(ClosedLoopClient);
    const alert = elements(failed).find((n) => n.type === "load-error")!;
    (alert.props.onRetry as () => void)(); await flush();
    const ready = render(ClosedLoopClient);
    expect(rows(ready)).toEqual(closedLoopData("retry").rows);
    expect(elements(ready).filter((n) => n.type === "statistic").map((n) => n.props.value)).toEqual([21, 0, "—", 0, 21, 0, 0]);
    expect(network.fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["success", "failure"] as const)("ignores a detached %s without state writes or messages", async (outcome) => {
    const pending = deferred();
    network.fetch.mockReturnValueOnce(pending.promise);
    render(ClosedLoopClient);
    unmount();
    const writes = hooks.writes;
    if (outcome === "success") pending.resolve(closedLoopData("detached"));
    else pending.reject(new Error("detached"));
    await flush();
    expect(hooks.writes).toBe(writes);
    expect(message.error).not.toHaveBeenCalled();
  });
});

describe("external SKU ranking current-filter facts", () => {
  it("aborts the previous platform read and ignores an out-of-order success", async () => {
    const old = deferred(), latest = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    selectPlatform(render(external), "pdd");
    render(external);
    expect(signal(0).aborted).toBe(true);
    expect(network.fetch.mock.calls[1][0]).toContain("platform=pdd");
    latest.resolve(ranking("new")); await flush();
    old.resolve(ranking("old")); await flush();
    expect(rows(render(external))).toEqual(ranking("new").rows);
  });

  it("ignores a superseded failure without clearing new loading or showing a stale error", async () => {
    const old = deferred(), latest = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    selectPlatform(render(external), "tmall"); render(external);
    old.reject(new Error("old failure")); await flush();
    const pending = render(external);
    expect(table(pending).props.loading).toBe(true);
    expect(message.error).not.toHaveBeenCalled();
    latest.resolve(ranking("new")); await flush();
    expect(table(render(external)).props.loading).toBe(false);
  });

  it("clears previous facts on a new query, keeps brand options, and labels current failure explicitly", async () => {
    const next = deferred();
    network.fetch.mockResolvedValueOnce(ranking("old")).mockReturnValueOnce(next.promise).mockResolvedValueOnce(ranking("retry"));
    render(external); await flush();
    selectPlatform(render(external), "pdd");
    const pending = render(external);
    expect(rows(pending)).toEqual([]);
    expect(button(pending, "导出 CSV").props.disabled).toBe(true);
    expect(elements(pending).find((node) => node.props.placeholder === "全部品牌")?.props.options).toEqual([{ value: "EXP", label: "EXP" }]);
    next.reject(new Error("network unavailable")); await flush();
    const failed = render(external);
    expect(elements(failed).find((node) => node.type === "alert")?.props.message).toBe("外部销量排名加载失败");
    expect(elements(failed).filter((node) => node.type === "statistic").every((node) => node.props.value === "—")).toBe(true);
    expect(text(failed)).toContain("窗口完整性未知");
    expect(text(failed)).not.toContain("未同步");
    click(button(failed, "重试")); await flush();
    expect(rows(render(external))).toEqual(ranking("retry").rows);
  });

  it("does not fetch inactive tabs and ignores detached results on deactivation or unmount", async () => {
    const old = deferred(); network.fetch.mockReturnValueOnce(old.promise);
    render(() => ExternalSkuRankingCard({ active: false }));
    expect(network.fetch).not.toHaveBeenCalled();
    render(external);
    render(() => ExternalSkuRankingCard({ active: false }));
    expect(signal(0).aborted).toBe(true);
    const writes = hooks.writes;
    old.resolve(ranking("detached")); await flush();
    expect(hooks.writes).toBe(writes);
    unmount();
  });

  it("cancels a pending export after filter changes and never downloads stale rows", async () => {
    const exported = deferred();
    network.fetch.mockResolvedValueOnce(ranking("old")).mockReturnValueOnce(exported.promise);
    render(external); await flush();
    const ready = render(external);
    click(button(ready, "导出 CSV"));
    click(button(ready, "导出 CSV"));
    expect(network.fetch).toHaveBeenCalledTimes(2);
    expect(network.fetch.mock.calls[1][0]).toContain("limit=5000");
    selectPlatform(ready, "pdd"); render(external);
    expect(signal(1).aborted).toBe(true);
    exported.resolve(ranking("stale export")); await flush();
    expect(network.csv).not.toHaveBeenCalled();
  });

  it("exports current ready facts but refuses an insufficient export response", async () => {
    network.fetch.mockResolvedValueOnce(ranking("current")).mockResolvedValueOnce(ranking("export"));
    render(external); await flush();
    click(button(render(external), "导出 CSV")); await flush();
    expect(network.csv).toHaveBeenCalledOnce();
    network.fetch.mockResolvedValueOnce({ ...ranking("none"), state: "insufficient", gate: "coverage unknown", rows: [] });
    click(button(render(external), "导出 CSV")); await flush();
    expect(network.csv).toHaveBeenCalledOnce();
    expect(message.error).toHaveBeenCalledWith("coverage unknown");
  });
});

const supplierCases = [
  { tab: "scorecard", prefix: "sc", filter: "windowDays", value: 90, query: "windowDays=90", data: scoreData },
  { tab: "qc", prefix: "qc", filter: "months", value: 3, query: "months=3", data: qcData },
  { tab: "price", prefix: "pv", filter: "windowDays", value: 90, query: "windowDays=90", data: priceData },
];
describe.each(supplierCases)("supplier $tab current-query loading", ({ tab, prefix, value, query, data }) => {
  const component = () => supplierTab(tab)();
  function changeWindow(tree: ReactNode) {
    const segmented = elements(tree).find((node) => node.type === "segmented")!;
    (segmented.props.onChange as (value: number) => void)(value);
  }
  it("aborts old window reads and only accepts the latest response", async () => {
    const old = deferred(), latest = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    changeWindow(render(component)); render(component);
    expect(signal(0).aborted).toBe(true);
    expect(network.fetch.mock.calls[1][0]).toContain(query);
    latest.resolve(data("new")); await flush();
    old.resolve(data("old")); await flush();
    expect(rows(render(component))).toEqual(data("new").rows);
  });
  it("old rejection cannot hide a current pending read or raise its error", async () => {
    const old = deferred(), latest = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    changeWindow(render(component)); render(component);
    old.reject(new Error("old failure")); await flush();
    expect(table(render(component)).props.loading).toBe(true);
    expect(message.error).not.toHaveBeenCalled();
    latest.resolve(data("new")); await flush();
    expect(rows(render(component))).toEqual(data("new").rows);
  });
  it("clears changed-query facts, shows unknown on failure, and retries the current query", async () => {
    const latest = deferred();
    network.fetch.mockResolvedValueOnce(data("old")).mockReturnValueOnce(latest.promise).mockResolvedValueOnce(data("retry"));
    render(component); await flush();
    changeWindow(render(component));
    expect(rows(render(component))).toEqual([]);
    latest.reject(new Error("current unavailable")); await flush();
    const failed = render(component);
    expect(table(failed).props.loading).toBe(false);
    expect(elements(failed).filter((node) => node.type === "statistic").every((node) => node.props.value === "—")).toBe(true);
    const visual = elements(failed).find((node) => node.type === "decision-visual");
    if (visual) {
      expect(visual.props.coverage).toBeUndefined();
      expect(visual.props.state).toBe("error");
      expect(visual.props.onExport).toBeUndefined();
    }
    const error = elements(failed).find((node) => node.type === "alert" && node.props.type === "error");
    expect(error?.props.description).toBe("current unavailable");
    click(button(failed, "重试")); await flush();
    expect(network.fetch.mock.calls[2][0]).toContain(query);
    expect(rows(render(component))).toEqual(data("retry").rows);
  });
  it("does not update component state or emit errors after unmount", async () => {
    const pending = deferred(); network.fetch.mockReturnValueOnce(pending.promise);
    render(component); unmount();
    expect(signal(0).aborted).toBe(true);
    const writes = hooks.writes;
    pending.reject(new Error("detached")); await flush();
    expect(hooks.writes).toBe(writes);
    expect(message.error).not.toHaveBeenCalled();
  });
  if (tab !== "qc") it("server-side pagination cancels the prior page request", async () => {
    const old = deferred(), next = deferred();
    network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const pagination = table(render(component)).props.pagination as { onChange: (page: number) => void };
    pagination.onChange(2); render(component);
    expect(lists.pages[prefix]).toBe(2);
    expect(network.fetch.mock.calls[1][0]).toContain("page=2");
    expect(signal(0).aborted).toBe(true);
    next.resolve(data("page 2")); await flush();
    old.resolve(data("page 1")); await flush();
    expect(rows(render(component))).toEqual(data("page 2").rows);
  });
});

it("a completed grade adoption refreshes the current page, not its captured old filters", async () => {
  const mutation = deferred();
  network.fetch.mockResolvedValueOnce(scoreData("initial")).mockResolvedValueOnce(scoreData("page 2")).mockResolvedValueOnce(scoreData("refreshed"));
  network.post.mockReturnValueOnce(mutation.promise);
  const component = () => supplierTab("scorecard")();
  render(component); await flush();
  const ready = render(component);
  const columns = table(ready).props.columns as { dataIndex: string; render: (value: string, row: unknown) => ReactNode }[];
  const grade = columns.find((column) => column.dataIndex === "grade")!.render("A", scoreData("initial").rows[0]);
  const confirm = elements(grade).find((node) => node.type === "popconfirm")!;
  (confirm.props.onConfirm as () => void)();
  lists.pages.sc = 2;
  render(component); await flush();
  mutation.resolve({ ok: true }); await flush();
  expect(network.post).toHaveBeenCalledWith("/api/report/supplier-scorecard", { supplierId: 1, level: "A" });
  expect(network.fetch.mock.calls[2][0]).toContain("page=2");
  expect(rows(render(component))).toEqual(scoreData("refreshed").rows);
});

describe("QC supplier filter uses authoritative server totals", () => {
  const component = () => supplierTab("qc")();
  const supplierSelect = (tree: ReactNode) => elements(tree).find((node) => node.type === "remote-select")!;
  const chooseSupplier = (tree: ReactNode, value: number | undefined) => (supplierSelect(tree).props.onChange as (value: number | undefined) => void)(value);
  const valueOf = (tree: ReactNode, title: string) => elements(tree).find((node) => node.type === "statistic" && node.props.title === title)?.props.value;

  it("loads a URL-preset supplier and uses service totals, never a sum or average of monthly rows", async () => {
    lists.filters.qc = { months: "6", supplierId: "1001" };
    const source = qcData("selected supplier");
    const data = {
      ...source,
      rows: [{ ...source.rows[0], supplierId: 1001, batches: 1, passQty: 1.23, passRate: 0.1111 }, { ...source.rows[0], supplierId: 1001, month: "2026-09", batches: 1, passQty: 4.56, passRate: 0.9999 }],
      months: ["2026-08", "2026-09"],
      // Same receipt in both months: global distinct count is not 1 + 1.
      totals: { batches: 1, passRate: 0.8765, concessionRate: 0.1235, scrapRate: 0 },
    };
    network.fetch.mockResolvedValueOnce(data);
    const pending = render(component);
    expect(network.fetch.mock.calls[0][0]).toBe("/api/report/qc-summary?months=6&supplierId=1001");
    const selected = supplierSelect(pending);
    expect(selected.props.api).toBe("/api/master/supplier");
    expect(selected.props.placeholder).toBe("全部供应商（主档）");
    expect(selected.props.value).toBe(1001);
    expect((selected.props.labelRender as (props: object) => string)({ value: 1001 })).toBe("供应商 #1001");
    await flush();
    const ready = render(component);
    expect(valueOf(ready, "收货批次")).toBe(1);
    expect(valueOf(ready, "合格率")).toBeCloseTo(87.65);
    expect(rows(ready)).toEqual(data.rows);
    expect((supplierSelect(ready).props.labelRender as (props: object) => string)({ value: 1001 })).toBe("selected supplier（S1）");
    expect(elements(ready).find((node) => node.type === "decision-visual")?.props.summary).toContain("selected supplier（S1）：收货批次 1");
  });

  it("rapid supplier switches abort old totals and clearing the selection restores the full-window query", async () => {
    const first = deferred(), second = deferred();
    network.fetch.mockResolvedValueOnce(qcData("all")).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(qcData("restored all"));
    render(component); await flush();
    chooseSupplier(render(component), 1); render(component);
    chooseSupplier(render(component), 2); const pending = render(component);
    expect(rows(pending)).toEqual([]);
    expect(valueOf(pending, "收货批次")).toBe("—");
    expect(signal(1).aborted).toBe(true);
    expect(network.fetch.mock.calls[2][0]).toBe("/api/report/qc-summary?months=6&supplierId=2");
    const current = { ...qcData("supplier 2"), totals: { batches: 7, passRate: null, concessionRate: null, scrapRate: null } };
    second.resolve(current); await flush();
    first.resolve(qcData("supplier 1")); await flush();
    expect(valueOf(render(component), "收货批次")).toBe(7);
    expect(valueOf(render(component), "合格率")).toBe("—");
    chooseSupplier(render(component), undefined); render(component); await flush();
    expect(network.fetch.mock.calls[3][0]).toBe("/api/report/qc-summary?months=6");
    expect(rows(render(component))).toEqual(qcData("restored all").rows);
  });

  it("no inspection records is a real zero count but an unknown rate, with a readable selected ID", async () => {
    lists.filters.qc = { months: "6", supplierId: "2222" };
    network.fetch.mockResolvedValueOnce({ rows: [], months: ["2026-08"], totals: { batches: 0, passRate: null, concessionRate: null, scrapRate: null } });
    render(component); await flush();
    const tree = render(component);
    expect(valueOf(tree, "收货批次")).toBe(0);
    expect(valueOf(tree, "合格率")).toBe("—");
    expect((supplierSelect(tree).props.labelRender as (props: object) => string)({ value: 2222 })).toBe("供应商 #2222");
    expect(elements(tree).find((node) => node.type === "decision-visual")?.props.state).toBe("empty");
  });

  it("a six-month calendar without inspection records has zero observed-month coverage", async () => {
    network.fetch.mockResolvedValueOnce({
      ...qcData("empty"),
      months: ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"],
      rows: [],
      totals: { batches: 0, passRate: null, concessionRate: null, scrapRate: null },
    });
    const pending = render(component);
    expect(elements(pending).find((node) => node.type === "decision-visual")?.props.coverage).toBeUndefined();
    await flush();
    expect(elements(render(component)).find((node) => node.type === "decision-visual")?.props.coverage).toEqual({
      covered: 0, total: 6, label: "有检验记录月份",
    });
  });

  it("counts distinct observed months rather than supplier rows or all requested calendar months", async () => {
    const source = qcData("supplier 1");
    network.fetch.mockResolvedValueOnce({
      ...source,
      months: ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"],
      rows: [source.rows[0], { ...source.rows[0], supplierId: 2, name: "supplier 2" }, { ...source.rows[0], month: "2026-09" }],
    });
    render(component); await flush();
    expect(elements(render(component)).find((node) => node.type === "decision-visual")?.props.coverage).toEqual({
      covered: 2, total: 6, label: "有检验记录月份",
    });
  });

  it.each(["0", "-1", " ", "abc", "1.5", "1e2", "2147483648"])("rejects malformed supplier %j without silently fetching all suppliers", (supplierId) => {
    lists.filters.qc = { months: "6", supplierId };
    const tree = render(component);
    expect(network.fetch).not.toHaveBeenCalled();
    expect(valueOf(tree, "收货批次")).toBe("—");
    expect(elements(tree).find((node) => node.type === "alert" && node.props.type === "error")?.props.description).toBe("供应商筛选无效，请重新选择供应商。");
  });

  it.each(["0", "37", "-1", "6.5", "bad"])("rejects invalid month window %j without falling back to another window", (months) => {
    lists.filters.qc = { months, supplierId: "" };
    const tree = render(component);
    expect(network.fetch).not.toHaveBeenCalled();
    expect(valueOf(tree, "收货批次")).toBe("—");
    expect(elements(tree).find((node) => node.type === "alert" && node.props.type === "error")?.props.description).toBe("月份筛选无效，请选择 1 至 36 个月。");
  });
});
