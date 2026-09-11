import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "@/components/CommandPalette";
import GlobalSearch from "@/components/GlobalSearch";
import { readSearchGroups } from "@/components/useEntitySearch";

// Exercise real component hooks and callbacks, not DOM focus/layout or AntD internals.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
const routing = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => routing }));
vi.mock("antd", () => ({ AutoComplete: "autocomplete", Modal: "modal", Button: "button", Input: "input", Tag: "tag", Typography: { Text: "text" } }));
vi.mock("react", async (original) => {
  const memo = (compute: () => unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { value: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || previous.deps.length !== deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.slots[index] = { value: compute(), deps };
    return (hooks.slots[index] as { value: unknown }).value;
  };
  return {
    ...await original<typeof import("react")>(),
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.slots[index], (update: T | ((previous: T) => T)) => {
        const next = typeof update === "function" ? (update as (previous: T) => T)(hooks.slots[index] as T) : update;
        if (!Object.is(hooks.slots[index], next)) hooks.changed = true;
        hooks.slots[index] = next;
      }];
    },
    useRef: <T,>(initial: T) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }; return hooks.slots[index]; },
    useMemo: memo,
    useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.slots[index] as readonly unknown[] | undefined;
      if (previous?.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
      hooks.slots[index] = deps;
      hooks.effects.push(() => { hooks.cleanups.get(index)?.(); hooks.cleanups.delete(index); const cleanup = effect(); if (cleanup) hooks.cleanups.set(index, cleanup); });
    },
  };
});
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Node["props"]>(value) ? [value, ...nodes(value.props.children)] : [];
const textOf = (value: ReactNode): string => Array.isArray(value) ? value.map(textOf).join("") : isValidElement<{ children?: ReactNode }>(value) ? textOf(value.props.children) : typeof value === "string" ? value : "";
const fetchMock = vi.fn<typeof fetch>();
const listeners = new Map<string, (event: unknown) => void>();
const roles = ["admin"];
let component: () => ReactNode;
function render() {
  for (let i = 0; i < 10; i++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = component();
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree;
  }
  throw new Error("Search did not settle");
}
const auto = () => nodes(render()).find(n => n.type === "autocomplete")!;
type Option = { value: string; label: ReactNode; disabled?: boolean };
const options = () => (auto().props.options as { options: Option[] }[]).flatMap(g => g.options ?? []);
function query(value: string) {
  const props = auto().props;
  ((props.onSearch ?? props.onChange) as (q: string) => void)(value);
  render();
}
function select(value: string) { (auto().props.onSelect as (value: string) => void)(value); render(); }
function key(value: string) { listeners.get("keydown")?.({ ctrlKey: value === "k", key: value, preventDefault() {} }); render(); }
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); render(); };
const reply = (items = [{ label: "相同名称", href: "/master/sku/1" }]) => Response.json({ groups: [{ title: "SKU", items }] });
function unmount() { for (const cleanup of hooks.cleanups.values()) cleanup(); hooks.cleanups.clear(); }
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.changed = false;
  fetchMock.mockReset(); routing.push.mockReset(); listeners.clear(); vi.useFakeTimers();
  vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { addEventListener: (event: string, callback: (e: unknown) => void) => listeners.set(event, callback), removeEventListener: (event: string) => listeners.delete(event) });
  component = () => CommandPalette({ roles });
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("navigation search correctness", () => {
  it("offers a pointer/touch entry without requiring a keyboard shortcut", () => {
    component = () => CommandPalette({ roles, compact: true });
    const trigger = nodes(render()).find(n => n.type === "button" && n.props["aria-label"] === "搜索页面与数据")!;
    expect(trigger).toBeDefined();
    expect(trigger.props["aria-haspopup"]).toBe("dialog");
    expect(trigger.props["aria-expanded"]).toBe(false);
    (trigger.props.onClick as () => void)();
    expect(nodes(render()).find(n => n.type === "modal")?.props.open).toBe(true);
  });
  it("focuses the search after the modal animation finishes, not when closing", () => {
    render(); key("k");
    const focus = vi.fn();
    (auto().props.ref as { current: unknown }).current = { focus };
    const modal = nodes(render()).find(n => n.type === "modal")!;
    (modal.props.afterOpenChange as (open: boolean) => void)(true);
    (modal.props.afterOpenChange as (open: boolean) => void)(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });
  it("returns focus to the pointer trigger on cancel but not after navigation", () => {
    const focus = vi.fn();
    const button = nodes(render()).find(n => n.props["aria-label"] === "搜索页面与数据")!;
    (button.props.ref as { current: unknown }).current = { focus, isConnected: true };
    (button.props.onClick as () => void)(); render();
    let modal = nodes(render()).find(n => n.type === "modal")!;
    (modal.props.onCancel as () => void)(); render();
    (modal.props.afterClose as () => void)(); expect(focus).toHaveBeenCalledTimes(1);
    (button.props.onClick as () => void)(); render(); query("SKU"); select("p:/master/sku");
    modal = nodes(render()).find(n => n.type === "modal")!;
    (modal.props.afterClose as () => void)(); expect(focus).toHaveBeenCalledTimes(1);
  });
  it("does not close the palette when Escape belongs to an IME composition", () => {
    render(); key("k");
    listeners.get("keydown")?.({ key: "Escape", isComposing: true, preventDefault() {} });
    expect(nodes(render()).find(n => n.type === "modal")?.props.open).toBe(true);
  });
  it("keeps a matching page clickable after entity results arrive", async () => {
    render(); key("k"); fetchMock.mockResolvedValueOnce(reply()); query("SKU");
    await vi.advanceTimersByTimeAsync(300); await flush();
    const page = options().find(o => o.value === "p:/master/sku")!;
    expect(page).toBeDefined(); select(page.value);
    expect(routing.push).toHaveBeenCalledWith("/master/sku");
  });
  it("distinguishes identically labelled records", async () => {
    render(); key("k"); fetchMock.mockResolvedValueOnce(reply([{ label: "相同名称", href: "/master/sku/1" }, { label: "相同名称", href: "/master/sku/2" }])); query("相同");
    await vi.advanceTimersByTimeAsync(300); await flush();
    const entities = options().filter(o => o.value.startsWith("e:"));
    expect(new Set(entities.map(o => o.value)).size).toBe(2);
    select(entities[0].value); expect(routing.push).toHaveBeenCalledWith("/master/sku/1");
  });
  it("withdraws results when closing and ignores the late response on reopen", async () => {
    const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
    render(); key("k"); query("SKU"); await vi.advanceTimersByTimeAsync(300);
    key("Escape"); pending.resolve(reply()); await flush(); key("k");
    expect(options().filter(o => o.value.startsWith("e:"))).toEqual([]);
  });
  it.each(["palette", "header"])("%s clears obsolete results immediately and does not navigate an obsolete key", async surface => {
    if (surface === "header") component = GlobalSearch;
    render(); if (surface === "palette") key("k");
    fetchMock.mockResolvedValueOnce(reply()); query("SKU"); await vi.advanceTimersByTimeAsync(300); await flush();
    const entity = options().find(o => textOf(o.label).includes("相同名称"))!;
    query("其他"); expect(options().some(o => textOf(o.label).includes("相同名称"))).toBe(false);
    select(entity.value); expect(routing.push).not.toHaveBeenCalled();
  });
  it.each(["palette", "header"])("%s ignores out-of-order replies and cancels pending work on unmount", async surface => {
    if (surface === "header") component = GlobalSearch;
    const old = Promise.withResolvers<Response>(), current = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    render(); if (surface === "palette") key("k");
    query("old"); await vi.advanceTimersByTimeAsync(300); query("new"); await vi.advanceTimersByTimeAsync(300);
    current.resolve(reply([{ label: "new result", href: "/master/sku/2" }])); await flush(); old.resolve(reply()); await flush();
    expect(options().some(o => textOf(o.label).includes("new result"))).toBe(true);
    expect(options().some(o => textOf(o.label).includes("相同名称"))).toBe(false);
    query("pending"); unmount(); await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each(["palette", "header"])("%s exposes request failure rather than no-match or previous results", async surface => {
    if (surface === "header") component = GlobalSearch;
    render(); if (surface === "palette") key("k"); fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    query("SKU"); await vi.advanceTimersByTimeAsync(300); await flush();
    expect(textOf(render()) + options().map(o => textOf(o.label)).join("")).toContain("搜索失败");
  });
  it.each(["palette", "header"])("%s uses Chinese recovery guidance and does not echo unknown errors", async surface => {
    if (surface === "header") component = GlobalSearch;
    render(); if (surface === "palette") key("k");
    fetchMock.mockRejectedValueOnce(new Error("private-upstream-marker Failed to fetch"));
    query("SKU"); await vi.advanceTimersByTimeAsync(300); await flush();
    const text = textOf(render()) + options().map(o => textOf(o.label)).join("");
    expect(text).toContain("网络或响应异常，请重试");
    expect(text).not.toContain("private-upstream-marker");
  });
  it.each(["palette", "header"])("%s clears to idle and aborts in-flight reads when the query is too short", async surface => {
    if (surface === "header") component = GlobalSearch;
    const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
    render(); if (surface === "palette") key("k");
    query("SKU"); await vi.advanceTimersByTimeAsync(300);
    query("");
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    pending.resolve(reply()); await flush(); await vi.advanceTimersByTimeAsync(11_000);
    expect(options().filter(o => o.value.startsWith("e:"))).toEqual([]);
    expect(textOf(render()) + options().map(o => textOf(o.label)).join("")).not.toContain("超时");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["palette", "header"])("%s times out honestly and retries without accepting the late response", async surface => {
    if (surface === "header") component = GlobalSearch;
    const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
    render(); if (surface === "palette") key("k"); query("SKU");
    await vi.advanceTimersByTimeAsync(10_300); await flush();
    expect(textOf(render()) + options().map(o => textOf(o.label)).join("")).toContain("搜索超时");
    const tree = surface === "header" ? (auto().props.popupRender as (node: ReactNode) => ReactNode)(null) : render();
    const retry = nodes(tree).find(n => n.type === "button" && textOf(n) === "重试搜索")!;
    fetchMock.mockResolvedValueOnce(reply([{ label: "重试成功", href: "/master/sku/2" }]));
    (retry.props.onClick as () => void)(); render(); await vi.advanceTimersByTimeAsync(300); await flush();
    pending.resolve(reply()); await flush();
    expect(options().some(o => textOf(o.label).includes("重试成功"))).toBe(true);
    expect(options().some(o => textOf(o.label).includes("相同名称"))).toBe(false);
  });
  it("discovers previously omitted pages and respects role-restricted destinations", () => {
    render(); key("k"); query("决策工作室");
    expect(options().some(o => o.value === "p:/report/decision-studio")).toBe(true);
    component = () => CommandPalette({ roles: ["warehouse"] });
    query("用户");
    expect(options().some(o => o.value === "p:/admin/users")).toBe(false);
  });
  it.each([{}, null, { groups: "bad" }, { groups: [{ title: "SKU", items: [{ label: "bad", href: "//example.com" }] }] },
    { groups: [{ title: "SKU", items: [{ label: "bad", href: "javascript:alert(1)" }] }] },
    { groups: [{ title: "SKU", items: [{ label: "bad", href: "/\\example.com" }] }] }])("rejects malformed or unsafe search payload %j", body => {
    expect(() => readSearchGroups(body)).toThrow("搜索数据格式异常");
  });
});
