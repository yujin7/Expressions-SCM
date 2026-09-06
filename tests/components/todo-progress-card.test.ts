import React, { isValidElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TodoProgressCard, { type TodoProgressBlock } from "@/app/(app)/todo/TodoProgressCard";

// Exercise real loading callbacks with deferred promises. This local hook harness
// checks lifecycle/props without adding DOM dependencies; it is not visual proof.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
  changed: false,
  writes: 0,
}));
const request = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("react", async (importOriginal) => ({
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
  useCallback: (callback: unknown, deps: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { callback: unknown; deps: readonly unknown[] } | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.slots[index] = { callback, deps };
    return (hooks.slots[index] as { callback: unknown }).callback;
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
}));
vi.mock("antd", () => ({ Card: "card", Button: "button", Progress: "progress" }));
vi.mock("next/link", () => ({ default: "next-link" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("@/components/dictionary", () => ({ roleLabel: (role: string) => ({ pmc: "生产计划", ops: "运营" })[role] ?? role }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: request.fetch }));

type ElementProps = {
  children?: ReactNode;
  extra?: ReactNode;
  href?: string;
  prefetch?: boolean;
  scroll?: boolean;
  "aria-label"?: string;
  open?: boolean;
  percent?: number;
  error?: string | null;
  onRetry?: () => void;
  onClick?: () => void;
};

function elements(node: ReactNode): React.ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.extra)];
}

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<ElementProps>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

function render(refreshKey = 0, compact = false): React.ReactElement {
  for (let pass = 0; pass < 5; pass += 1) {
    hooks.cursor = 0;
    hooks.changed = false;
    const element = TodoProgressCard({ refreshKey, compact });
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return element;
  }
  throw new Error("Component did not settle");
}

function unmount() {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
}

function deferred() {
  let resolve!: (value: TodoProgressBlock) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TodoProgressBlock>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<TodoProgressBlock> = {}): TodoProgressBlock {
  return {
    generatedAt: "2026-09-06T00:00:00.000Z",
    month: "2026-09",
    mine: { open: 3, overdue: 1 },
    totals: { open: 7, overdue: 2, doneThisMonth: 4, completionRate: 50 },
    byRole: [{ role: "pmc", open: 7, overdue: 2, doneThisMonth: 4, completionRate: 50 }],
    caliber: "完成率（宽）= 已完成 ÷ (总数 − 已取消)；手工来源不计入；月份按创建时间（Asia/Shanghai）",
    href: "/todo",
    ...overrides,
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const labelText = (tree: ReactNode, label: string) => text(elements(tree).find((node) => node.props["aria-label"] === label));

beforeEach(() => {
  // Explicit, isolated runtime for Vitest's classic JSX transform.
  vi.stubGlobal("React", React);
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.effects = [];
  hooks.cleanups.clear();
  hooks.changed = false;
  hooks.writes = 0;
  request.fetch.mockReset();
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("TodoProgressCard compact summary and safe loading", () => {
  it("keeps unloaded values unknown and role evidence collapsed, with one summary request", () => {
    request.fetch.mockReturnValue(new Promise(() => {}));
    const tree = render();
    expect(request.fetch).toHaveBeenCalledOnce();
    expect(request.fetch.mock.calls[0][0]).toBe("/api/todo/stats?scope=summary");
    expect(labelText(tree, "我的待办摘要")).toBe("指派给我 · 未完成—");
    expect(labelText(tree, "本月完成率摘要")).not.toContain("0%");
    expect(text(tree)).toContain("正在加载待办进度");
    expect(elements(tree).find((node) => node.type === "details")?.props.open).toBeUndefined();
  });

  it("preserves all six metrics and full source caliber in collapsed evidence, including compact mode", async () => {
    const data = fixture();
    request.fetch.mockResolvedValue(data);
    render();
    await flush();
    const tree = render(0, true);
    expect(elements(tree).filter((node) => node.type === "section" && node.props["aria-label"]?.endsWith("摘要"))).toHaveLength(6);
    expect(labelText(tree, "本月系统待办完成摘要")).toContain("4");
    expect(labelText(tree, "本月完成率摘要")).toContain("50%");
    expect(text(tree)).toContain(data.caliber);
    expect(text(tree)).toContain("生产计划");
    expect(text(tree)).toContain("上海时间");
    expect(text(tree)).toContain("不作员工排名");
    expect(elements(tree).find((node) => node.type === "details")?.props.open).toBeUndefined();
  });

  it("links personal, scope, and role counts to the correct tab and active filter namespace", async () => {
    request.fetch.mockResolvedValue(fixture());
    render();
    await flush();
    const links = elements(render()).filter((node) => node.props.href);
    const hrefs = links.map((node) => node.props.href!);
    for (const link of links) {
      expect(link.type).toBe("next-link");
      expect(link.props.prefetch).toBe(false);
      expect(link.props.scroll).not.toBe(false);
    }
    expect(hrefs).toContain("/todo?tab=all");
    for (const href of hrefs.filter((value) => value !== "/todo?tab=all")) {
      const params = new URL(href, "https://example.test").searchParams;
      const tab = params.get("tab");
      expect(["mine", "all"]).toContain(tab);
      expect(params.get(`${tab}_status`)).toBe("active");
      if (params.has("all_ownerRole")) {
        expect(tab).toBe("all");
        expect(params.get("all_ownerRole")).toBe("pmc");
      }
    }
    expect(hrefs).toContain("/todo?tab=mine&mine_status=active&mine_overdue=1");
    expect(hrefs).toContain("/todo?tab=all&all_status=active&all_ownerRole=pmc&all_overdue=1");
  });

  it("shows real zero counts but never renders an unknown completion rate as a zero progress bar", async () => {
    request.fetch.mockResolvedValue(fixture({
      mine: { open: 0, overdue: 0 },
      totals: { open: 0, overdue: 0, doneThisMonth: 0, completionRate: null },
      byRole: [{ role: "ops", open: 0, overdue: 0, doneThisMonth: 0, completionRate: null }],
    }));
    render();
    await flush();
    const tree = render();
    expect(labelText(tree, "我的待办摘要")).toBe("指派给我 · 未完成0");
    expect(labelText(tree, "本月完成率摘要")).toContain("—无可计算系统待办");
    expect(elements(tree).some((node) => node.type === "progress")).toBe(false);
  });

  it("aborts replaced reads and prevents an older successful response from overwriting the latest one", async () => {
    const old = deferred();
    const latest = deferred();
    request.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(0);
    const oldSignal = request.fetch.mock.calls[0][1].signal as AbortSignal;
    render(1);
    expect(oldSignal.aborted).toBe(true);
    latest.resolve(fixture({ mine: { open: 99, overdue: 1 } }));
    await flush();
    old.resolve(fixture({ mine: { open: 3, overdue: 1 } }));
    await flush();
    expect(labelText(render(1), "我的待办摘要")).toBe("指派给我 · 未完成99");
  });

  it("ignores an old request's failure after a newer request succeeds", async () => {
    const old = deferred();
    const latest = deferred();
    request.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(0);
    render(1);
    latest.resolve(fixture());
    await flush();
    old.reject(new Error("stale failure"));
    await flush();
    const tree = render(1);
    expect(elements(tree).find((node) => node.type === "load-error")?.props.error).toBeNull();
    expect(labelText(tree, "我的待办摘要")).toBe("指派给我 · 未完成3");
  });

  it("labels refreshing values as old, then clears them on current failure and supports explicit retry", async () => {
    const refresh = deferred();
    request.fetch.mockResolvedValueOnce(fixture()).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(fixture());
    render(0);
    await flush();
    expect(text(render(1))).toContain("更新中，以上为上次结果");
    refresh.reject(new Error("database unavailable"));
    await flush();
    const failed = render(1);
    expect(labelText(failed, "我的待办摘要")).toBe("指派给我 · 未完成—");
    expect(text(failed)).toContain("本次统计不可用");
    const error = elements(failed).find((node) => node.type === "load-error")!;
    expect(error.props.error).toBe("database unavailable");
    error.props.onRetry!();
    await flush();
    expect(labelText(render(1), "我的待办摘要")).toBe("指派给我 · 未完成3");
  });

  it("aborts on unmount and never updates state when a detached request later resolves", async () => {
    const pending = deferred();
    request.fetch.mockReturnValue(pending.promise);
    render();
    const signal = request.fetch.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    const writes = hooks.writes;
    pending.resolve(fixture());
    await flush();
    expect(hooks.writes).toBe(writes);
  });

  it("uses a container-responsive 6/3/2-column grid instead of a permanently expanded role list", () => {
    const css = readFileSync("src/app/(app)/todo/TodoProgressCard.module.css", "utf8");
    for (const columns of [6, 3, 2]) expect(css).toContain(`repeat(${columns}, minmax(0, 1fr))`);
    expect(css).toContain("@container (max-width: 820px)");
    expect(css).toContain("@container (max-width: 480px)");
  });
});
