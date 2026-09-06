import React, { isValidElement, type ReactNode } from "react";
import type { SelectProps } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RemoteSelect, { type RemoteSelectProps } from "@/components/RemoteSelect";
import { readRemotePage, remoteListUrl, selectedValueBatches, type RemoteRow } from "@/lib/remote-select";

// Real component effects/callbacks with a small hook harness. These are behavior
// assertions, not browser scheduling, keyboard accessibility, or visual proof.
const hooks = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(), changed: false, writes: 0,
}));
vi.mock("react", async (original) => {
  const memo = (compute: () => unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      hooks.slots[index] = { value: compute(), deps };
    }
    return (hooks.slots[index] as { value: unknown }).value;
  };
  return {
    ...await original<typeof import("react")>(),
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.slots[index], (update: T | ((previous: T) => T)) => {
        const next = typeof update === "function" ? (update as (previous: T) => T)(hooks.slots[index] as T) : update;
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
      if (previous?.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
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
vi.mock("antd", () => ({ Select: "select", Button: "button" }));

const fetchMock = vi.fn<typeof fetch>();
let props: RemoteSelectProps;
function render(next: Partial<RemoteSelectProps> = {}) {
  props = { ...props, ...next };
  for (let pass = 0; pass < 10; pass++) {
    hooks.cursor = 0;
    hooks.changed = false;
    const tree = RemoteSelect(props) as React.ReactElement<SelectProps>;
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree.props;
  }
  throw new Error("RemoteSelect did not settle");
}
function unmount() {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
}
function resetHooks() { hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.changed = false; hooks.writes = 0; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const loaded = async () => { await flush(); return render(); };
const row = (id: number, extra: Record<string, unknown> = {}): RemoteRow => ({ id, name: `名称 ${id}`, ...extra });
const response = (rows: RemoteRow[], total = rows.length, envelope = "data") => Response.json({ [envelope]: rows, total });
const deferred = () => Promise.withResolvers<Response>();
const options = (view: SelectProps) => view.options as { value: string | number; label: string; disabled: boolean }[];
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function nodes(node: ReactNode): React.ReactElement<{ children?: ReactNode; onClick?: () => void }>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function menu(view: SelectProps) { return view.popupRender!(React.createElement("div", {}, "候选")); }
function click(view: SelectProps, label: string) {
  const button = nodes(menu(view)).find((node) => node.type === "button" && text(node) === label);
  expect(button, label).toBeDefined();
  button!.props.onClick!();
  return render();
}
function open() { render().onOpenChange!(true); return render(); }
function url(index: number) { return new URL(String(fetchMock.mock.calls[index][0]), "http://fixture.local"); }

beforeEach(() => {
  resetHooks();
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", fetchMock);
  props = { api: "/api/master/sku?type=finished", getLabel: (item) => String(item.name) };
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("RemoteSelect bounded search and lifecycle", () => {
  it("does not read unopened empty selects; opens once and only loads further pages explicitly", async () => {
    render();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response(Array.from({ length: 50 }, (_, i) => row(i + 1)), 101));
    open();
    let view = await loaded();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url(0).searchParams.get("pageSize")).toBe("50");
    expect(url(0).searchParams.get("type")).toBe("finished");
    view.onOpenChange!(false); render(); open();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(response(Array.from({ length: 50 }, (_, i) => row(i + 51)), 101));
    click(view, "加载更多");
    view = await loaded();
    expect(url(1).searchParams.get("page")).toBe("2");
    expect(options(view)).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("finds a target beyond the old 999 cap by debounced server search", async () => {
    fetchMock.mockResolvedValueOnce(response([row(1)], 1));
    open();
    let view = await loaded();
    fetchMock.mockResolvedValueOnce(response([row(1001, { name: "远端精确候选" })]));
    view.onSearch!("远端");
    view = render();
    expect(options(view)).toEqual([]);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    view = await loaded();
    expect(url(1).searchParams.get("q")).toBe("远端");
    expect(options(view)).toMatchObject([{ value: 1001, label: "远端精确候选" }]);
    expect(view.filterOption).toBe(false);
  });

  it("coalesces synchronous double clicks for the same in-flight page or retry", async () => {
    fetchMock.mockResolvedValueOnce(response(Array.from({ length: 50 }, (_, i) => row(i + 1)), 51));
    open(); let view = await loaded();
    const second = deferred();
    fetchMock.mockReturnValueOnce(second.promise);
    click(view, "加载更多");
    click(view, "加载更多");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.reject(new Error("offline"));
    view = await loaded();
    const retry = deferred();
    fetchMock.mockReturnValueOnce(retry.promise);
    click(view, "重试选项");
    click(view, "重试选项");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    retry.resolve(response([row(51)], 51));
    expect(options(await loaded())).toHaveLength(51);
  });

  it("refreshes candidates and selected labels without clearing the user's value", async () => {
    props.value = 1001;
    fetchMock.mockResolvedValueOnce(response([row(1001)]));
    render(); await loaded();
    fetchMock.mockResolvedValueOnce(response([row(1)]));
    open(); let view = await loaded();
    fetchMock.mockResolvedValueOnce(response([row(2)]))
      .mockResolvedValueOnce(response([row(1001, { name: "更新名称" })]));
    click(view, "刷新选项");
    view = await loaded();
    expect(view.value).toBe(1001);
    expect(options(view)).toMatchObject([{ value: 2 }, { value: 1001, label: "更新名称" }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(url(2).searchParams.has("selectedValues")).toBe(false);
    expect(url(3).searchParams.get("selectedValues")).toBe("[1001]");
  });

  it("keeps pagination available when client eligibility removes the entire first page", async () => {
    props.filterRow = (item) => item.active === true;
    fetchMock.mockResolvedValueOnce(response(Array.from({ length: 50 }, (_, i) => row(i + 1, { active: false })), 51));
    open();
    let view = await loaded();
    expect(options(view)).toEqual([]);
    fetchMock.mockResolvedValueOnce(response([row(51, { active: true })], 51));
    click(view, "加载更多");
    view = await loaded();
    expect(options(view)).toMatchObject([{ value: 51 }]);
    expect(options(render({ getLabel: (item) => `新标签 ${item.id}` }))[0].label).toBe("新标签 51");
  });

  it.each(["first", "search", "page"])("shows and retries a %s failure without silently returning an empty list", async (stage) => {
    fetchMock.mockResolvedValueOnce(stage === "first" ? new Response("", { status: 503 }) : response(Array.from({ length: 50 }, (_, i) => row(i + 1)), 51));
    open();
    let view = await loaded();
    if (stage === "page") {
      fetchMock.mockRejectedValueOnce(new Error("offline"));
      click(view, "加载更多");
      view = await loaded();
      expect(options(view)).toHaveLength(50);
    } else if (stage === "search") {
      fetchMock.mockResolvedValueOnce(Response.json({ unexpected: [] }));
      view.onSearch!("search"); render();
      await vi.advanceTimersByTimeAsync(250);
      view = await loaded();
    }
    expect(text(menu(view))).toContain("选项加载失败");
    fetchMock.mockResolvedValueOnce(response([row(51)], stage === "page" ? 51 : 1));
    click(view, "重试选项");
    view = await loaded();
    expect(text(menu(view))).not.toContain("选项加载失败");
    expect(url(fetchMock.mock.calls.length - 1).searchParams.get("page")).toBe(stage === "page" ? "2" : "1");
  });

  it("handles stock-doc rows envelopes and rejects malformed totals rather than claiming zero options", async () => {
    props.api = "/api/inventory/stock-doc?subtype=transfer&status=completed";
    fetchMock.mockResolvedValueOnce(response([row(45)], 1, "rows"));
    open();
    expect(options(await loaded())).toMatchObject([{ value: 45 }]);
    expect(() => readRemotePage({ data: [], total: "5" })).toThrow();
    expect(() => readRemotePage({ rows: [{ id: -1 }], total: 1 })).toThrow();
    expect(() => readRemotePage({ data: [row(1), row(1)], total: 2 })).toThrow();
  });

  it.each(["resolve", "reject"])("ignores stale search %s and cancels requests on unmount", async (outcome) => {
    const first = deferred();
    fetchMock.mockReturnValueOnce(first.promise);
    open();
    const firstSignal = fetchMock.mock.calls[0][1]!.signal!;
    fetchMock.mockResolvedValueOnce(response([row(2)]));
    render().onSearch!("B"); render();
    expect(firstSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(options(await loaded())).toMatchObject([{ value: 2 }]);
    const writes = hooks.writes;
    if (outcome === "resolve") first.resolve(response([row(1)])); else first.reject(new Error("old error"));
    await flush();
    expect(hooks.writes).toBe(writes);
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    render({ api: "/api/master/channel" });
    await vi.advanceTimersByTimeAsync(250);
    unmount();
    const afterUnmount = hooks.writes;
    pending.resolve(response([row(3)])); await flush();
    expect(hooks.writes).toBe(afterUnmount);
  });

  it("never reuses a previous mounted component's options or in-flight request", async () => {
    fetchMock.mockResolvedValueOnce(response([row(1)]));
    open(); await loaded();
    unmount(); resetHooks();
    fetchMock.mockResolvedValueOnce(response([row(2)]));
    open();
    expect(options(await loaded())).toMatchObject([{ value: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears internal search when a reused select changes from SKU to brand", async () => {
    fetchMock.mockResolvedValueOnce(response([row(1)]));
    open(); await loaded();
    fetchMock.mockResolvedValueOnce(response([row(2)]));
    render().onSearch!("SKU专用词"); render();
    await vi.advanceTimersByTimeAsync(250); await loaded();
    fetchMock.mockResolvedValueOnce(response([row(3, { name: "品牌" })]));
    const changing = render({ api: "/api/master/brand" });
    expect(changing.searchValue).toBe("");
    const view = await loaded();
    expect(url(2).searchParams.has("q")).toBe(false);
    expect(options(view)).toMatchObject([{ value: 3, label: "品牌" }]);
  });

  it("does not cancel the effective controlled search if its parent declines a new term", async () => {
    props.searchValue = "accepted";
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    open();
    await vi.advanceTimersByTimeAsync(250);
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    render().onSearch!("declined");
    expect(render().searchValue).toBe("accepted");
    expect(signal.aborted).toBe(false);
    pending.resolve(response([row(6)]));
    const view = await loaded();
    expect(view.loading).toBe(false);
    expect(options(view)).toMatchObject([{ value: 6 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("composes consumer handlers and preserves controlled values, loading, label rendering and popup content", async () => {
    const onSearch = vi.fn(), onChange = vi.fn(), onOpenChange = vi.fn(), onPopupScroll = vi.fn();
    const labelRender = vi.fn(({ label }: { label?: ReactNode }) => label);
    props = { ...props, onSearch, onChange, onOpenChange, onPopupScroll, labelRender, loading: true,
      popupRender: () => React.createElement("div", {}, "自定义菜单"), value: undefined };
    fetchMock.mockResolvedValueOnce(response([row(1)]));
    open(); const view = await loaded();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(view.loading).toBe(true);
    expect(view.labelRender).toBe(labelRender);
    expect(text(menu(view))).toContain("自定义菜单");
    view.onSearch!("名称");
    expect(onSearch).toHaveBeenCalledWith("名称");
    const scroll = {} as React.UIEvent<HTMLDivElement>;
    view.onPopupScroll!(scroll);
    expect(onPopupScroll).toHaveBeenCalledWith(scroll);
    view.onChange!(1, { value: 1, label: "名称 1" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1, { value: 1, label: "名称 1" });
    expect(render().value).toBeUndefined();
  });
});

describe("RemoteSelect exact selected-value hydration", () => {
  it("loads a tail ID label while closed, preserves fixed filters and does not fetch candidate pages", async () => {
    props = { ...props, api: "/api/master/sku?type=finished&q=fixed", value: 1001 };
    fetchMock.mockResolvedValueOnce(response([row(1001)]));
    render();
    expect(options(await loaded())).toMatchObject([{ value: 1001, label: "名称 1001", disabled: false }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(url(0).searchParams.get("selectedValues")!)).toEqual([1001]);
    expect(url(0).searchParams.get("type")).toBe("finished");
    expect(url(0).searchParams.get("q")).toBe("fixed");
  });

  it("strictly preserves code/name/string values, labelInValue and multi-select values", async () => {
    props = { ...props, mode: "multiple", labelInValue: true, value: [{ value: "EXP" }, { value: "1" }], getValue: (item) => String(item.code) };
    fetchMock.mockResolvedValueOnce(response([row(21, { code: "EXP" }), row(1, { code: "different" })]));
    render(); const view = await loaded();
    expect(options(view)).toMatchObject([{ value: "EXP", label: "名称 21" }, { value: "1", disabled: false }]);
    expect(options(view)[1].label).toContain("不存在或不在可选范围");
    expect(view.value).toEqual([{ value: "EXP" }, { value: "1" }]);
    expect(view.labelInValue).toBe(true);
  });

  it.each(["filtered", "missing", "ambiguous", "incomplete"] as const)("never silently clears or invents labels for %s selected records", async (kind) => {
    const onChange = vi.fn();
    props = { ...props, value: "same", getValue: () => "same", onChange, filterRow: (item) => item.active !== false };
    const rows = kind === "missing" ? [] : kind === "ambiguous" ? [row(1), row(2)] : [row(1, { active: kind !== "filtered" })];
    fetchMock.mockResolvedValueOnce(response(rows, kind === "incomplete" ? 201 : rows.length));
    render(); const view = await loaded();
    expect(view.value).toBe("same");
    expect(options(view)[0].disabled).toBe(false);
    expect(options(view)[0].label).toContain({ filtered: "当前不可选", missing: "不存在或不在可选范围", ambiguous: "重名", incomplete: "补取不完整" }[kind]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("can retry failed exact hydration without losing selected values", async () => {
    props.value = 55;
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    render(); let view = await loaded();
    expect(options(view)[0].label).toContain("名称加载失败");
    fetchMock.mockResolvedValueOnce(response([row(55)]));
    click(view, "重试已选名称"); view = await loaded();
    expect(options(view)).toMatchObject([{ value: 55, label: "名称 55" }]);
    expect(view.value).toBe(55);
  });

  it.each(["loading", "failed", "filtered", "ambiguous"] as const)("keeps %s multi-select values removable without admitting unavailable new candidates", async (kind) => {
    const onChange = vi.fn();
    props = { ...props, mode: "multiple", value: ["old"], getValue: (item) => String(item.code), onChange,
      filterRow: (item) => item.active !== false };
    const rejectedRows = kind === "ambiguous"
      ? [row(1, { code: "old" }), row(2, { code: "old" })]
      : [row(1, { code: "old", active: false })];
    if (kind === "loading") fetchMock.mockReturnValueOnce(deferred().promise);
    else if (kind === "failed") fetchMock.mockRejectedValueOnce(new Error("offline"));
    else fetchMock.mockResolvedValueOnce(response(rejectedRows));
    render(); await loaded();
    fetchMock.mockResolvedValueOnce(response(rejectedRows));
    open(); let view = await loaded();
    expect(view.allowClear).toBeUndefined();
    expect(view.value).toEqual(["old"]);
    expect(options(view).find((option) => option.value === "old")?.disabled).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    // The same onChange contract used by rc-select's × and Backspace removal.
    view.onChange!([], []);
    expect(onChange).toHaveBeenCalledWith([], []);
    view = render({ value: [] });
    const remaining = options(view).find((option) => option.value === "old");
    if (kind === "ambiguous") expect(remaining).toMatchObject({ disabled: true });
    else expect(remaining).toBeUndefined();
    expect(render({ disabled: true }).disabled).toBe(true);
  });

  it("batches only selected values by count and encoded length, and cancels remaining batches on value changes", async () => {
    const names = Array.from({ length: 55 }, (_, i) => `${"中".repeat(195)}${i}`);
    const batches = selectedValueBatches(names);
    expect(batches.flat()).toEqual(names);
    expect(batches.every((batch) => batch.length <= 50 && encodeURIComponent(JSON.stringify(batch)).length <= 6000)).toBe(true);
    expect(selectedValueBatches(Array.from({ length: 101 }, (_, i) => i + 1)).map((batch) => batch.length)).toEqual([50, 50, 1]);
    props = { ...props, mode: "multiple", value: names };
    const old = deferred();
    fetchMock.mockReturnValueOnce(old.promise);
    render();
    const oldSignal = fetchMock.mock.calls[0][1]!.signal!;
    fetchMock.mockResolvedValueOnce(response([row(700)]));
    render({ value: [700] });
    expect(oldSignal.aborted).toBe(true);
    old.resolve(response([]));
    expect(options(await loaded())).toMatchObject([{ value: 700, label: "名称 700" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not carry a previously valid label through a new empty exact response", async () => {
    fetchMock.mockResolvedValueOnce(response([row(9)]));
    open(); let view = await loaded();
    fetchMock.mockResolvedValueOnce(response([]));
    view.onChange!(9, { value: 9, label: "名称 9" }); render();
    view = await loaded();
    expect(options(view).find((option) => option.value === 9)?.label).toContain("不存在或不在可选范围");
  });

  it("URL construction replaces pagination keys and retains original fixed search only for hydration", () => {
    const search = new URL(remoteListUrl("/api/master/brand?page=9&pageSize=999&q=base", 1, "new"), "http://test");
    expect(search.searchParams.getAll("page")).toEqual(["1"]);
    expect(search.searchParams.get("q")).toBe("new");
    const selected = new URL(remoteListUrl("/api/master/brand?q=base", 1, undefined, ["EXP"]), "http://test");
    expect(selected.searchParams.get("q")).toBe("base");
  });
});
