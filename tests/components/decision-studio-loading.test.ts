import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DecisionStudioClient from "@/app/(app)/report/decision-studio/decision-studio-client";
import { buildDecisionStudio, type DecisionStudioResult, type StudioDimension } from "@/server/modules/report/decision-studio";

// Real component callbacks + pure production model builder; this is lifecycle
// and rendered-prop evidence, not a browser/React scheduler or visual assertion.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
  changed: false,
  writes: 0,
}));
const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  filters: { dimension: "brand", key: "", tab: "focus", brand: "", channel: "", product: "" },
}));

vi.mock("react", async (importOriginal) => {
  const memo = (compute: () => unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      hooks.slots[index] = { value: compute(), deps };
    }
    return (hooks.slots[index] as { value: unknown }).value;
  };
  return {
    ...await importOriginal<typeof import("react")>(),
    useState: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = initial;
      return [hooks.slots[index], (next: T) => {
        hooks.writes += 1;
        if (!Object.is(hooks.slots[index], next)) hooks.changed = true;
        hooks.slots[index] = next;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
      return hooks.slots[index];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
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
  };
});
vi.mock("next/dynamic", () => ({ default: () => "readiness-panel" }));
vi.mock("antd", () => ({
  Alert: "alert", App: { useApp: () => ({ message: state.message }) },
  Button: "button", Card: "card", Col: "col", Progress: "progress",
  Radio: { Group: "radio-group" }, Row: "row", Select: "select", Space: "space",
  Statistic: "statistic", Table: "table", Tabs: "tabs", Tag: "tag",
  Typography: { Title: "title", Text: "text", Paragraph: "paragraph" },
}));
vi.mock("recharts", () => Object.fromEntries([
  "Area", "Bar", "CartesianGrid", "Cell", "ComposedChart", "Line", "LineChart",
  "ReferenceLine", "ResponsiveContainer", "Tooltip", "XAxis", "YAxis",
].map((name) => [name, name])));
vi.mock("@ant-design/icons", () => ({ CopyOutlined: "copy-icon", DownloadOutlined: "download-icon", ReloadOutlined: "reload-icon" }));
vi.mock("@/components/DecisionVisual", () => ({ default: "decision-visual" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote-select" }));
vi.mock("@/app/(app)/report/decision-studio/platform-sku-gap-card", () => ({ default: "sku-gap-card" }));
vi.mock("@/app/(app)/report/decision-studio/channel-observation-card", () => ({ default: "observation-card" }));
vi.mock("@/app/(app)/report/decision-studio/external-sku-ranking-card", () => ({ default: "external-ranking-card" }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: state.fetch }));
vi.mock("@/components/useListState", () => ({
  useListState: () => ({ filters: state.filters, setFilter: (next: Partial<typeof state.filters>) => Object.assign(state.filters, next) }),
}));

type Props = {
  children?: ReactNode;
  extra?: ReactNode;
  action?: ReactNode;
  items?: { key: string; children: ReactNode }[];
  title?: string;
  value?: unknown;
  message?: string;
  description?: string;
  options?: { value: string; label: string }[];
  onClick?: () => void;
  loading?: boolean;
  role?: string;
  state?: string;
  summary?: string;
  coverage?: { covered: number; total: number; label: string };
};
function elements(node: ReactNode): React.ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.extra), ...elements(node.props.action),
    ...(node.props.items ?? []).flatMap((item) => elements(item.children))];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render(runEffects = true): React.ReactElement {
  for (let pass = 0; pass < 6; pass += 1) {
    hooks.cursor = 0;
    hooks.changed = false;
    const element = DecisionStudioClient();
    if (!runEffects) return element;
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return element;
  }
  throw new Error("Component did not settle");
}
function unmount() {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(qty: number, dimension: StudioDimension = "brand") {
  return buildDecisionStudio([{ month: "2026-08", key: "fixture", label: "受控测试事实", qty }], [], { dimension });
}
const deferred = () => Promise.withResolvers<DecisionStudioResult>();
const quantity = (tree: ReactNode) => elements(tree).find((node) => node.type === "statistic" && node.props.title?.endsWith("销量"))?.props.value;
const error = (tree: ReactNode) => elements(tree).find((node) => node.type === "alert" && node.props.message === "决策数据加载失败")?.props.description;
function coreVisuals(tree: ReactNode) {
  const tabs = elements(tree).find((node) => node.type === "tabs")?.props.items ?? [];
  return ["focus", "trend", "pivot", "daily"].map((key) => {
    const tab = tabs.find((item) => item.key === key);
    const visual = elements(tab?.children).find((node) => node.type === "decision-visual");
    expect(visual, `${key} core visual`).toBeDefined();
    return { key, props: visual!.props };
  });
}
function refresh(tree: ReactNode) {
  const button = elements(tree).find((node) => node.type === "button" && text(node) === "刷新");
  expect(button).toBeDefined();
  button!.props.onClick!();
}
function visit(brand: string) {
  state.filters.brand = brand;
  return render();
}
async function loaded(brand: string, qty: number) {
  state.fetch.mockResolvedValueOnce(fixture(qty));
  visit(brand);
  await flush();
  expect(quantity(render())).toBe(qty);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.effects = [];
  hooks.cleanups.clear();
  hooks.changed = false;
  hooks.writes = 0;
  state.fetch.mockReset();
  for (const message of Object.values(state.message)) message.mockReset();
  state.filters = { dimension: "brand", key: "", tab: "focus", brand: "", channel: "", product: "" };
});
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Decision Studio query-bound loading and response cache", () => {
  it("all four core visuals withhold coverage and empty conclusions until the current response arrives", () => {
    state.fetch.mockReturnValueOnce(deferred().promise);
    for (const tree of [render(false), render()]) {
      for (const { props } of coreVisuals(tree)) {
        expect(props.state).toBe("loading");
        expect(props.coverage).toBeUndefined();
        expect(props.summary).toContain("正在读取");
        expect(props.summary).not.toMatch(/0\s*\/\s*0|没有|无数据|0 个成员/);
      }
      expect(quantity(tree)).toBe("—");
    }
  });

  it("a valid empty result shows real zero coverage while its unavailable sales metric remains unknown", async () => {
    const request = deferred();
    state.fetch.mockReturnValueOnce(request.promise);
    render();
    request.resolve(buildDecisionStudio([], []));
    await flush();
    const tree = render();
    expect(error(tree)).toBeUndefined();
    expect(quantity(tree)).toBe("—");
    for (const { key, props } of coreVisuals(tree)) {
      expect(props.coverage).toMatchObject({ covered: 0, total: key === "trend" ? 12 : 0 });
      expect(props.state).toBe(key === "daily" ? "insufficient" : "empty");
      expect(props.summary).not.toContain("正在读取");
      if (key === "focus") expect(props.summary).toContain("没有可排名的销量事实");
      if (key === "pivot") expect(props.summary).toContain("0 个成员");
    }
  });

  it.each(["success", "failure"])("A slow / B fast: ignores A's late %s and never caches it", async (outcome) => {
    const a = deferred();
    const b = deferred();
    state.fetch.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    visit("A");
    const signal = state.fetch.mock.calls[0][1].signal as AbortSignal;
    visit("B");
    expect(signal.aborted).toBe(true);
    b.resolve(fixture(22));
    await flush();
    expect(quantity(render())).toBe(22);
    const writes = hooks.writes;
    if (outcome === "success") a.resolve(fixture(11)); else a.reject(new Error("stale failure"));
    await flush();
    expect(quantity(render())).toBe(22);
    expect(hooks.writes).toBe(writes);
    expect(state.message.error).not.toHaveBeenCalled();
    state.fetch.mockReturnValueOnce(deferred().promise);
    expect(quantity(visit("A"))).toBe("—");
    expect(state.fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["success", "failure"])("returning to cached B cancels A and ignores its late %s", async (outcome) => {
    await loaded("B", 22);
    const a = deferred();
    state.fetch.mockReturnValueOnce(a.promise);
    visit("A");
    const signal = state.fetch.mock.calls[1][1].signal as AbortSignal;
    expect(quantity(visit("B"))).toBe(22);
    expect(signal.aborted).toBe(true);
    expect(state.fetch).toHaveBeenCalledTimes(2);
    const writes = hooks.writes;
    if (outcome === "success") a.resolve(fixture(11)); else a.reject(new Error("cached-view stale failure"));
    await flush();
    expect(quantity(render())).toBe(22);
    expect(hooks.writes).toBe(writes);
    expect(error(render())).toBeUndefined();
    expect(state.message.error).not.toHaveBeenCalled();
  });

  it("withdraws old-dimension values during the URL render before passive effects run", async () => {
    await loaded("A", 11);
    state.filters.dimension = "channel";
    state.fetch.mockReturnValueOnce(deferred().promise);
    const beforeEffects = render(false);
    expect(quantity(beforeEffects)).toBe("—");
    expect(elements(beforeEffects).find((node) => node.type === "radio-group")?.props.value).toBe("channel");
    expect(elements(beforeEffects).find((node) => node.type === "select")?.props.options).toEqual([]);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    render();
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(state.fetch.mock.calls[1][0]).toContain("dimension=channel");
  });

  it("failed force refresh withdraws both visible data and the previous cache entry", async () => {
    await loaded("A", 11);
    await loaded("B", 22);
    expect(quantity(visit("A"))).toBe(11);
    const update = deferred();
    state.fetch.mockReturnValueOnce(update.promise);
    refresh(render());
    expect(quantity(render())).toBe("—");
    update.reject(new Error("refresh failed"));
    await flush();
    const failed = render();
    expect(quantity(failed)).toBe("—");
    expect(error(failed)).toBe("refresh failed");
    const tabChildren = elements(failed).find((node) => node.type === "tabs")?.props.items ?? [];
    expect(tabChildren.length).toBeGreaterThan(0);
    for (const tab of tabChildren) {
      expect(elements(tab.children).some((node) => node.props.role === "status")).toBe(true);
      expect(elements(tab.children).some((node) => node.type === "decision-visual")).toBe(false);
    }
    expect(quantity(visit("B"))).toBe(22);
    state.fetch.mockReturnValueOnce(deferred().promise);
    expect(quantity(visit("A"))).toBe("—");
    expect(state.fetch).toHaveBeenCalledTimes(4);
  });

  it("expires at 30 seconds and cache hits do not extend the original freshness window", async () => {
    await loaded("A", 11);
    await loaded("B", 22);
    vi.mocked(Date.now).mockReturnValue(30_999);
    expect(quantity(visit("A"))).toBe(11);
    expect(state.fetch).toHaveBeenCalledTimes(2);
    visit("B");
    vi.mocked(Date.now).mockReturnValue(31_000);
    state.fetch.mockReturnValueOnce(deferred().promise);
    expect(quantity(visit("A"))).toBe("—");
    expect(state.fetch).toHaveBeenCalledTimes(3);
  });

  it("a clock rollback invalidates a future-dated cache entry instead of extending freshness", async () => {
    await loaded("A", 11);
    await loaded("B", 22);
    vi.mocked(Date.now).mockReturnValue(999);
    state.fetch.mockReturnValueOnce(deferred().promise);
    expect(quantity(visit("A"))).toBe("—");
    expect(state.fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps at most 12 query results: a thirteenth result evicts the oldest, not a newer view", async () => {
    for (let i = 0; i < 13; i += 1) await loaded(`B${i}`, i + 1);
    expect(state.fetch).toHaveBeenCalledTimes(13);
    expect(quantity(visit("B1"))).toBe(2);
    expect(state.fetch).toHaveBeenCalledTimes(13);
    state.fetch.mockReturnValueOnce(deferred().promise);
    expect(quantity(visit("B0"))).toBe("—");
    expect(state.fetch).toHaveBeenCalledTimes(14);
  });

  it.each(["success", "failure"])("unmount cancels and never writes state for a late %s", async (outcome) => {
    const request = deferred();
    state.fetch.mockReturnValueOnce(request.promise);
    render();
    const signal = state.fetch.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    const writes = hooks.writes;
    if (outcome === "success") request.resolve(fixture(11)); else request.reject(new Error("detached failure"));
    await flush();
    expect(hooks.writes).toBe(writes);
    expect(state.message.error).not.toHaveBeenCalled();
  });

  it.each([{}, null, { dimension: "channel" }])("rejects malformed/mismatched JSON envelope %j without caching or rendering it", async (payload) => {
    state.fetch.mockResolvedValueOnce(payload);
    visit("A");
    await flush();
    const tree = render();
    expect(quantity(tree)).toBe("—");
    expect(error(tree)).toContain("决策数据结构异常");
    expect(state.message.error).toHaveBeenCalledOnce();
    await loaded("B", 22);
    state.fetch.mockReturnValueOnce(deferred().promise);
    expect(quantity(visit("A"))).toBe("—");
    expect(state.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["SPC container", (value: DecisionStudioResult) => ({ ...value, spc: undefined })],
    ["monthly array", (value: DecisionStudioResult) => ({ ...value, monthly: null })],
    ["pivot array", (value: DecisionStudioResult) => ({ ...value, pivot: undefined })],
    ["review bullets", (value: DecisionStudioResult) => ({ ...value, review: {} })],
    ["daily dates", (value: DecisionStudioResult) => ({ ...value, daily: { ...value.daily, dates: {} } })],
    ["external demand container", (value: DecisionStudioResult) => ({ ...value, externalDemand: {} })],
    ["external decision brief", (value: DecisionStudioResult) => ({ ...value, externalDemand: { ...value.externalDemand, decisionBrief: {} } })],
    ["commerce summary", (value: DecisionStudioResult) => ({ ...value, commerceIdentity: { ...value.commerceIdentity, summary: undefined } })],
  ] as const)("rejects a broken %s before rendering or cache admission", async (_label, damage) => {
    state.fetch.mockResolvedValueOnce(damage(fixture(11)));
    visit("A");
    await flush();
    expect(() => render()).not.toThrow();
    const tree = render();
    expect(quantity(tree)).toBe("—");
    expect(error(tree)).toContain("决策数据结构异常");
    await loaded("B", 22);
    state.fetch.mockReturnValueOnce(deferred().promise);
    expect(quantity(visit("A"))).toBe("—");
    expect(state.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([null, 0, 12.5])("preserves nullable numeric comparison %j without coercing unknown to zero", async (value) => {
    const model = fixture(11);
    state.fetch.mockResolvedValueOnce({ ...model, comparison: { ...model.comparison, current: value, momPct: value } });
    render();
    await flush();
    const tree = render();
    expect(error(tree)).toBeUndefined();
    expect(quantity(tree)).toBe(value ?? "—");
    expect(elements(tree).find((node) => node.type === "statistic" && node.props.title === "环比")?.props.value)
      .toBe(value == null ? "数据不足" : `+${value.toFixed(1)}%`);
  });

  it.each([
    ["current", undefined], ["previous", "0"], ["momPct", "12"], ["yearAgo", false],
    ["yoyPct", {}], ["momPct", Number.NaN], ["yoyPct", Number.POSITIVE_INFINITY],
  ])("rejects invalid comparison %s=%j before numeric formatting", async (key, value) => {
    const model = fixture(11);
    state.fetch.mockResolvedValueOnce({ ...model, comparison: { ...model.comparison, [String(key)]: value } });
    render();
    await flush();
    expect(() => render()).not.toThrow();
    expect(error(render())).toContain("决策数据结构异常");
    expect(quantity(render())).toBe("—");
  });

  it("a transport AbortError without a cancelled caller signal becomes an actionable failure, not endless loading", async () => {
    state.fetch.mockRejectedValueOnce(new DOMException("响应体中断", "AbortError"));
    render();
    await flush();
    const tree = render();
    expect(error(tree)).toBe("响应体中断");
    expect(elements(tree).find((node) => node.type === "button" && text(node) === "刷新")?.props.loading).toBe(false);
  });
});
