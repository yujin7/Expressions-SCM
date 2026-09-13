import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TodoMutationRecovery, { TodoMutationRecoveryDrawer } from "@/app/(app)/todo/TodoMutationRecovery";
import { loadTodoMutation, prepareTodoMutation, TODO_MUTATION_OPEN, type TodoMutationLookup, type TodoMutationRequest } from "@/components/todo-mutation-request";
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false, unmounted: false, lateWrites: 0 }));
const m = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn(), confirmed: vi.fn() }));
vi.mock("react", async original => {
  const effect = (fn: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++, prior = h.slots[index] as unknown[] | undefined;
    if (prior && deps.length === prior.length && deps.every((d, i) => Object.is(d, prior[i]))) return;
    h.slots[index] = deps; h.effects.push(() => { h.cleanups.get(index)?.(); const cleanup = fn(); if (cleanup) h.cleanups.set(index, cleanup); });
  };
  return { ...await original<typeof import("react")>(), useEffect: effect, useLayoutEffect: effect,
    useState: <T,>(initial: T | (() => T)) => {
      const index = h.cursor++; if (!(index in h.slots)) h.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [h.slots[index], (next: T | ((value: T) => T)) => { if (h.unmounted) h.lateWrites++; const value = typeof next === "function" ? (next as (value: T) => T)(h.slots[index] as T) : next; if (!Object.is(value, h.slots[index])) h.changed = true; h.slots[index] = value; }];
    },
    useRef: <T,>(initial: T) => { const index = h.cursor++; if (!(index in h.slots)) h.slots[index] = { current: initial }; return h.slots[index]; },
  };
});
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Drawer: "drawer", Space: "space" }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: m.fetch }));
type Props = { children?: ReactNode; description?: ReactNode; message?: ReactNode; action?: ReactNode; href?: string; disabled?: boolean; closable?: boolean; keyboard?: boolean;
  onClick?: () => void; ref?: { current: Pick<HTMLDivElement, "focus" | "scrollIntoView"> | null }; tabIndex?: number };
function all(node: ReactNode): React.ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(all);
  return isValidElement<Props>(node) ? [node, ...all(node.props.children), ...all(node.props.description), ...all(node.props.action)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Props>(node) ? text(node.props.children) + text(node.props.message) + text(node.props.description) : typeof node === "string" || typeof node === "number" ? String(node) : "";
}
let request: TodoMutationRequest;
const render = (fn = () => TodoMutationRecoveryDrawer({ actorId: 1, request, onClose: m.close, onConfirmed: m.confirmed })) => {
  for (let i = 0; i < 6; i++) { h.cursor = 0; h.changed = false; const tree = fn(); h.effects.splice(0).forEach(f => f()); if (!h.changed) return tree; }
  throw Error("did not settle");
};
const click = (name: string) => { const button = all(render()).find(e => e.type === "button" && text(e) === name); expect(button).toBeDefined(); expect(button!.props.disabled).not.toBe(true); button!.props.onClick!(); };
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const unmount = () => { h.unmounted = true; h.cleanups.forEach(fn => fn()); };
const data = new Map<string, string>();
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const current = { id: 7, title: "合成原操作", version: 1, status: "open" as const, assigneeId: 1, assigneeName: "合成人员", completedAt: null, suspicious: false };
const saved = { version: 2, status: "done" as const, assigneeId: 1, completedAt: "2026-09-13T00:00:00.000Z", suspicious: false };
const missing = (version = 1): TodoMutationLookup => ({ itemId: 7, requestId: request.requestId, receipt: null, current: { ...current, version } });
const found = (): TodoMutationLookup => ({ itemId: 7, requestId: request.requestId, receipt: { eventId: 17, requestId: request.requestId,
  originalIntent: { expectedVersion: 1, status: "done", assigneeId: null, note: null }, originalResult: saved }, current: { ...current, version: 3 } });
beforeEach(() => {
  h.cursor = 0; h.slots = []; h.effects = []; h.cleanups.clear(); h.changed = false; h.unmounted = false; h.lateWrites = 0; data.clear(); vi.clearAllMocks(); m.fetch.mockReset();
  vi.stubGlobal("React", React); vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { locks: { request: (_key: string, fn: () => Promise<unknown>) => fn() } });
  request = prepareTodoMutation(storage, 1, current, { status: "done" });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });
it("opening recovery never sends automatically and exposes the original operation", () => {
  const tree = render(); expect(text(tree)).toContain("合成原操作"); expect(text(tree)).toContain("超时不代表"); expect(m.fetch).not.toHaveBeenCalled();
  expect(all(tree).find(e => e.type === "drawer")?.props).toMatchObject({ closable: true, keyboard: true, width: "min(560px, 100vw)" });
  expect(all(tree).filter(e => e.type === "button")).toHaveLength(1);
});
it("found original result and later current state are both shown; only explicit acknowledgement clears", async () => {
  m.fetch.mockResolvedValue(found()); render(); click("核对原操作结果"); await flush(); const tree = render();
  expect(text(tree)).toContain("原操作已保存"); expect(text(tree)).toContain("任务后来已有更新"); expect(text(tree)).toContain("已完成"); expect(text(tree)).toContain("待处理");
  expect(loadTodoMutation(storage, 1)).toEqual(request); expect(m.confirmed).not.toHaveBeenCalled();
  click("确认回执并清理本机记录"); await flush(); expect(loadTodoMutation(storage, 1)).toBeNull(); expect(m.confirmed).toHaveBeenCalledWith(found(), false);
  expect(m.fetch.mock.calls.every(c => c[1].method === undefined)).toBe(true);
});
it("missing current version permits explicit same-request retry, not a new UUID", async () => {
  m.fetch.mockResolvedValueOnce(missing()).mockResolvedValueOnce(missing()).mockResolvedValueOnce({ ...current, ...saved, replayed: false, mutationReceipt: found().receipt });
  render(); click("核对原操作结果"); await flush(); expect(m.fetch).toHaveBeenCalledOnce();
  click("重试原操作"); await flush(); expect(m.fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(m.fetch.mock.calls[2][1].body)).toMatchObject({ requestId: request.requestId, expectedVersion: 1, status: "done" });
  expect(loadTodoMutation(storage, 1)).toEqual(request); expect(text(render())).toContain("原操作已保存");
});
it("retry rechecks first and never PATCHes if the receipt appeared meanwhile", async () => {
  m.fetch.mockResolvedValueOnce(missing()).mockResolvedValueOnce(found()); render(); click("核对原操作结果"); await flush(); click("重试原操作"); await flush();
  expect(m.fetch.mock.calls.every(c => c[1].method === undefined)).toBe(true); expect(text(render())).toContain("原操作已保存"); expect(loadTodoMutation(storage, 1)).toEqual(request);
});
it("obsolete missing operation can be acknowledged without sending it", async () => {
  m.fetch.mockResolvedValue(missing(3)); render(); click("核对原操作结果"); await flush(); expect(all(render()).some(e => text(e) === "重试原操作")).toBe(false);
  click("确认未执行并清理本机记录"); await flush(); expect(loadTodoMutation(storage, 1)).toBeNull(); expect(m.confirmed).toHaveBeenCalledWith(missing(3), true);
  expect(m.fetch.mock.calls.every(c => c[1].method === undefined)).toBe(true);
});
it("changed acknowledgement evidence is shown for another explicit confirmation, never silently erased", async () => {
  m.fetch.mockResolvedValueOnce(missing(3)).mockResolvedValueOnce(found()); render(); click("核对原操作结果"); await flush(); click("确认未执行并清理本机记录"); await flush();
  expect(loadTodoMutation(storage, 1)).toEqual(request); expect(m.confirmed).not.toHaveBeenCalled(); expect(text(render())).toContain("核对结果已变化");
});
it("awaiting lookup disables drawer close; unmount preserves pending record and ignores late response", async () => {
  let resolve!: (v: unknown) => void; m.fetch.mockReturnValue(new Promise(r => { resolve = r; })); render(); click("核对原操作结果");
  expect(all(render()).find(e => e.type === "drawer")?.props).toMatchObject({ closable: false, keyboard: false });
  unmount(); resolve(found()); await flush(); expect(h.lateWrites).toBe(0); expect(m.confirmed).not.toHaveBeenCalled(); expect(loadTodoMutation(storage, 1)).toEqual(request);
});
it("unmount while waiting for another tab lock never starts a request", async () => {
  let enter!: () => Promise<unknown>;
  vi.stubGlobal("navigator", { locks: { request: (_key: string, fn: () => Promise<unknown>) => { enter = fn; return new Promise(() => {}); } } });
  render(); click("核对原操作结果"); unmount(); await enter(); expect(m.fetch).not.toHaveBeenCalled(); expect(loadTodoMutation(storage, 1)).toEqual(request);
});
it("a replaced local request is not queried or cleared", async () => {
  render(); data.set("scm:todo-mutation:v1:1", JSON.stringify({ ...request, requestId: crypto.randomUUID() })); click("核对原操作结果"); await flush();
  expect(m.fetch).not.toHaveBeenCalled(); expect(text(render())).toContain("本机原请求已变化"); expect(loadTodoMutation(storage, 1)).not.toBeNull();
});
it("result and error focus targets are applied after the updated content exists", async () => {
  const focus = vi.fn(), scrollIntoView = vi.fn(); const node = all(render()).find(e => e.props.tabIndex === -1)!; node.props.ref!.current = { focus, scrollIntoView };
  m.fetch.mockRejectedValue(Error("合成断网")); click("核对原操作结果"); await flush(); render();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true }); expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }); expect(loadTodoMutation(storage, 1)).toEqual(request);
});
it("account-scoped entry stays independent of list filters and ignores other actors' open events", () => {
  const fn = () => TodoMutationRecovery({ actorId: 1, onChanged: vi.fn() }); const tree = render(fn); expect(text(tree)).toContain("待办 #7 有原操作待确认"); expect(m.fetch).not.toHaveBeenCalled();
  window.dispatchEvent(new CustomEvent(TODO_MUTATION_OPEN, { detail: 2 })); expect(all(render(fn)).some(e => e.type === TodoMutationRecoveryDrawer)).toBe(false);
  window.dispatchEvent(new CustomEvent(TODO_MUTATION_OPEN, { detail: 1 })); expect(all(render(fn)).some(e => e.type === TodoMutationRecoveryDrawer)).toBe(true); expect(m.fetch).not.toHaveBeenCalled();
});
