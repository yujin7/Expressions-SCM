import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Panel from "@/app/(app)/master/sku/sku-source-status-panel";

const state = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: [] as (() => void)[], fetch: vi.fn(), confirmed: vi.fn(), pending: vi.fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Checkbox: "checkbox", Collapse: "collapse", Empty: "empty", Grid: { useBreakpoint: () => ({ sm: true }) },
  Input: { TextArea: "textarea" }, Pagination: "pagination", Radio: "radio", Select: "select", Space: "space", Spin: "spin", Table: "table", Tag: "tag", Typography: { Paragraph: "p", Text: "text" } }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: state.fetch }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(), useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = initial; return [state.slots[i], (v: unknown) => { state.slots[i] = typeof v === "function" ? v(state.slots[i]) : v; }]; },
  useRef: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = { current: initial }; return state.slots[i]; },
  useEffect: (fn: () => (() => void)) => { const i = state.cursor++; if (!(i in state.slots)) { state.slots[i] = true; state.effects.push(() => state.cleanups.push(fn())); } },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children), ...nodes(v.props.action as ReactNode)] : [];
const view = { sku: { id: 7, lifecycle: "halted", active: false, commercialRole: "sample" }, sources: [{ key: "jdy", label: "合成镜像", rows: [{ id: 8 }], mode: "snapshot", latestAttempt: null }], history: [], fingerprint: "a".repeat(64), canWrite: true };
const render = () => { state.cursor = 0; const tree = Panel({ skuId: 7, onConfirmed: state.confirmed, onPendingChange: state.pending }); for (const effect of state.effects.splice(0)) effect(); return tree; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const props = (type: string) => nodes(render()).find(n => n.type === type)!.props;
const button = (text: string) => nodes(render()).find(n => n.type === "button" && n.props.children === text)!.props;
const click = (text: string) => (button(text).onClick as () => void)();
async function fill() {
  render(); await flush();
  (nodes(render()).find(n => n.props.source)!.props.onSelect as (key: string) => void)("jdy:8");
  (props("select").onChange as (value: string) => void)("trial");
  (props("textarea").onChange as (e: unknown) => void)({ target: { value: "合成业务依据已核实" } });
  (props("checkbox").onChange as (e: unknown) => void)({ target: { checked: true } });
}
beforeEach(() => { state.cursor = 0; state.slots = []; state.effects = []; state.cleanups = []; state.fetch.mockReset().mockResolvedValueOnce(view); state.confirmed.mockReset(); state.pending.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { for (const cleanup of state.cleanups) cleanup?.(); vi.unstubAllGlobals(); });

it("double activation before a rerender sends one request and focuses persistent content", async () => {
  await fill(); const focus = vi.fn(); (render().props.ref as { current: unknown }).current = { focus };
  const deferred = Promise.withResolvers<unknown>(); state.fetch.mockReturnValue(deferred.promise);
  const action = button("确认并留痕").onClick as () => void; action(); action();
  expect(state.fetch).toHaveBeenCalledTimes(2); expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  const body = JSON.parse(state.fetch.mock.calls[1][1].body); expect(body).toMatchObject({ source: "jdy", rowId: 8, lifecycle: "trial", independentlyVerified: true });
  deferred.reject(new Error("lost response")); await flush();
});
it("malformed success retains the exact submission for explicit replay rather than claiming saved", async () => {
  await fill(); state.fetch.mockResolvedValueOnce({}); click("确认并留痕"); await flush();
  expect(state.confirmed).not.toHaveBeenCalled(); expect(props("textarea")).toMatchObject({ value: "合成业务依据已核实", disabled: true });
  state.fetch.mockResolvedValueOnce({ auditId: 81, lifecycle: "trial", replayed: true }).mockResolvedValueOnce(view);
  click("核对同一次提交"); await flush();
  expect(state.fetch.mock.calls[2][1].body).toBe(state.fetch.mock.calls[1][1].body);
  expect(state.confirmed).toHaveBeenCalledExactlyOnceWith("trial"); expect(JSON.stringify(render())).toContain("未重复写入");
});
it("read failures distinguish unavailable evidence from an empty source and expose retry", async () => {
  state.fetch.mockReset().mockRejectedValueOnce(new Error("503 unavailable")); render(); await flush();
  expect(JSON.stringify(render())).toContain("来源状态读取失败"); expect(nodes(render()).some(n => n.type === "select")).toBe(false);
  state.fetch.mockResolvedValueOnce(view); click("重新读取"); await flush(); expect(props("select").value).toBeUndefined();
});
it("late result after unmount does not change another panorama", async () => {
  await fill(); const deferred = Promise.withResolvers<unknown>(); state.fetch.mockReturnValueOnce(deferred.promise);
  click("确认并留痕"); for (const cleanup of state.cleanups) cleanup?.();
  deferred.resolve({ auditId: 82, lifecycle: "trial", replayed: false }); await flush(); expect(state.confirmed).not.toHaveBeenCalled(); expect(state.fetch).toHaveBeenCalledTimes(2);
});
