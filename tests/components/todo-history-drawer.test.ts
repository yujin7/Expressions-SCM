import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TodoHistoryDrawer from "@/app/(app)/todo/TodoHistoryDrawer";

const state = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: [] as (() => void)[], fetch: vi.fn(), retry: vi.fn(), url: "", nextBefore: null as number | null }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Drawer: "drawer", Space: "space", Spin: "spin", Input: { TextArea: "textarea" } }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: state.fetch }));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: (url: string) => { state.url = url; return { phase: "success", data: { rows: [], nextBefore: state.nextBefore }, error: null, retry: state.retry }; } }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = initial; return [state.slots[i], (v: unknown) => { state.slots[i] = v; }]; },
  useRef: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = { current: initial }; return state.slots[i]; },
  useEffect: (fn: () => (() => void)) => { const i = state.cursor++; if (!(i in state.slots)) { state.slots[i] = true; state.effects.push(() => state.cleanups.push(fn())); } },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const render = () => { state.cursor = 0; const tree = TodoHistoryDrawer({ id: 7, title: "合成跟进", onClose: () => {} }); for (const effect of state.effects.splice(0)) effect(); return tree; };
const input = () => nodes(render()).find(n => n.type === "textarea")!.props;
const button = (text: string) => nodes(render()).find(n => n.type === "button" && n.props.children === text)!.props;
const click = (text: string) => (button(text).onClick as () => void)();
const type = (value: string) => (input().onChange as (e: unknown) => void)({ target: { value } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => { state.cursor = 0; state.slots = []; state.effects = []; state.cleanups = []; state.nextBefore = null; state.fetch.mockReset(); state.retry.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { for (const cleanup of state.cleanups) cleanup(); vi.unstubAllGlobals(); });

it("loads only the selected item's scoped history and rejects empty notes", () => {
  render(); expect(state.url).toBe("/api/todo/7/history"); click("保存跟进"); expect(state.fetch).not.toHaveBeenCalled();
});
it("keeps focus in the persistent drawer content before pagination or retry removes its trigger", () => {
  state.nextBefore = 123;
  const content = nodes(render()).find(n => n.type === "div" && n.props.tabIndex === -1);
  expect(content, "pagination needs a persistent focus target inside the drawer").toBeDefined();
  const focus = vi.fn();
  (content!.props.ref as { current: unknown }).current = { focus };
  click("更早20条");
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  state.nextBefore = null; render();
  expect(state.url).toBe("/api/todo/7/history?before=123");
  expect(nodes(render()).some(n => n.type === "button" && n.props.children === "更早20条")).toBe(false);
  click("最新记录"); render();
  expect(state.url).toBe("/api/todo/7/history");
  expect(focus).toHaveBeenCalledTimes(2);
  const error = nodes(render()).find(n => n.type === "load-error")!;
  (error.props.onRetry as () => void)();
  expect(focus).toHaveBeenCalledTimes(3);
  expect(state.retry).toHaveBeenCalledTimes(2);
});
it("locks duplicate clicks and drawer closing while saving, then shows a durable receipt", async () => {
  const pending = Promise.withResolvers<unknown>(); state.fetch.mockReturnValue(pending.promise);
  type("工厂正在确认可交日期"); click("保存跟进"); click("保存跟进");
  expect(state.fetch).toHaveBeenCalledTimes(1); expect(render().props).toMatchObject({ closable: false, maskClosable: false, keyboard: false });
  pending.resolve({ eventId: 45, replayed: false }); await flush();
  expect(input().value).toBe(""); expect(JSON.stringify(render())).toContain("跟进已保存（记录 #45）"); expect(state.retry).toHaveBeenCalledTimes(1);
});
it("retains focus before disabling submit controls, including explicit uncertain-result confirmation", async () => {
  const content = nodes(render()).find(n => n.type === "div" && n.props.tabIndex === -1)!;
  const focus = vi.fn();
  (content.props.ref as { current: unknown }).current = { focus };
  state.fetch.mockImplementationOnce(() => {
    expect(focus).toHaveBeenCalledTimes(1);
    expect(render().props.keyboard).toBe(false);
    return Promise.reject(new Error("lost response"));
  });
  type("合成保存回执丢失后确认"); click("保存跟进");
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  await flush();
  expect(render().props.keyboard).toBe(true);
  state.fetch.mockImplementationOnce(() => {
    expect(focus).toHaveBeenCalledTimes(2);
    return Promise.resolve({ eventId: 48, replayed: true });
  });
  click("确认同一提交"); await flush();
  expect(render().props.keyboard).toBe(true);
  expect(input().value).toBe("");
  expect(JSON.stringify(render())).toContain("跟进已保存（记录 #48）");
});
it("uncertain failure preserves content and request ID; only explicit confirmation retries", async () => {
  state.fetch.mockRejectedValueOnce(new Error("timeout")); type("等待供应商书面依据"); click("保存跟进"); await flush();
  expect(state.fetch).toHaveBeenCalledTimes(1); expect(input()).toMatchObject({ value: "等待供应商书面依据", disabled: true });
  state.fetch.mockResolvedValueOnce({ eventId: 46, replayed: true }); click("确认同一提交"); await flush();
  expect(state.fetch.mock.calls[1][1].body).toBe(state.fetch.mock.calls[0][1].body);
  expect(input().value).toBe(""); expect(state.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
it("malformed success is not reported as saved", async () => {
  state.fetch.mockResolvedValueOnce({}); type("合成未确认回执情况"); click("保存跟进"); await flush();
  expect(input().value).toBe("合成未确认回执情况"); expect(state.retry).not.toHaveBeenCalled(); expect(button("确认同一提交")).toBeDefined();
});
it("an unmounted drawer ignores a late write result without retrying or resetting another item", async () => {
  const pending = Promise.withResolvers<unknown>(); state.fetch.mockReturnValue(pending.promise);
  type("合成关闭后迟到的回执"); click("保存跟进"); for (const cleanup of state.cleanups) cleanup();
  pending.resolve({ eventId: 47, replayed: false }); await flush(); expect(state.retry).not.toHaveBeenCalled();
  expect(input().value).toBe("合成关闭后迟到的回执");
});
