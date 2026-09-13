import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CapacityHandoffForm } from "@/components/CapacityHandoff";
import type { CapacityCheck } from "@/server/modules/outsource/capacity-check";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: [] as (() => void)[] }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Input: { TextArea: "textarea" }, Select: "select", Space: "space" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (value: unknown) => { hooks.slots[i] = value; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i]; },
  useEffect: (effect: () => void | (() => void)) => { const i = hooks.cursor++; if (!(i in hooks.slots)) { hooks.slots[i] = true; hooks.effects.push(() => { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup); }); } },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Node["props"]>(value) ? [value, ...nodes(value.props.children), ...nodes(value.props.description as ReactNode)] : [];
const fetchMock = vi.fn<typeof fetch>(), busy = vi.fn(), focus = vi.fn();
let check: CapacityCheck | null;
function render() { hooks.cursor = 0; const tree = CapacityHandoffForm({ check, onBusyChange: busy, actorId: 1 }); for (const effect of hooks.effects.splice(0)) effect(); return tree; }
const find = (type: string) => nodes(render()).find(node => node.type === type)!;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); return render(); };
function fill() { render(); (find("select").props.onChange as (v: number) => void)(7); (find("textarea").props.onChange as (e: unknown) => void)({ target: { value: "请核对真实交期与供应商依据" } });
  (render().props.ref as { current: unknown }).current = { focus }; render(); }
const click = (label = "保存到承接待办") => (nodes(render()).find(n => n.type === "button" && n.props.children === label)!.props.onClick as () => void)();
const payload = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
const stored = new Map<string, string>();
const local = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } };
const remount = () => { for (const cleanup of hooks.cleanups) cleanup(); hooks.slots = []; hooks.cleanups = []; hooks.effects = []; render(); return render(); };
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.cleanups = []; fetchMock.mockReset(); busy.mockReset(); focus.mockReset();
  vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock);
  stored.clear(); vi.stubGlobal("localStorage", local); vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("navigator", { locks: { request: (_key: string, action: () => Promise<unknown>) => action() } });
  check = { sku: { id: 1, code: "FG", name: "精华", baseUom: "支" }, factories: [], evidenceKey: "a".repeat(64),
    scenario: { supplierId: 2, dueDate: "2026-09-30", candidateQty: "300.0001", signal: {} },
    handoff: { source: { id: 3, category: "inventory_cover", title: "核对告警", status: "open", lastHitAt: null, fingerprint: "a" },
      items: [{ id: 7, title: "真实承接", assigneeId: 9, assigneeName: "采购", updatedAt: "2026-09-09" }] } } as unknown as CapacityCheck; // This callback harness does not render the signal; service/browser tests use real signals.
});
afterEach(() => { for (const cleanup of hooks.cleanups) cleanup(); vi.unstubAllGlobals(); });
it("does not auto-select owner, post on render or accept a vanished scenario", () => {
  render(); expect(find("button").props.disabled).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
  fill(); const oldClick = find("button").props.onClick as () => void;
  check = null; render(); expect(nodes(render()).some(n => n.type === "button")).toBe(false);
  // User cannot reach the old rendered callback; no automatic effect invokes it.
  expect(typeof oldClick).toBe("function"); expect(fetchMock).not.toHaveBeenCalled();
});
it("duplicate clicks post once, bind the explicit source/owner/evidence and retain focus and receipt", async () => {
  fill(); const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValue(pending.promise);
  const originalClick = find("button").props.onClick as () => void;
  originalClick(); originalClick(); expect(fetchMock).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(payload()).toMatchObject({ skuId: 1, alertId: 3, supplierId: 2, workItemId: 7, assigneeId: 9, candidateQty: "300.0001", evidenceKey: "a".repeat(64) });
  check = null; render(); pending.resolve(Response.json({ itemId: 7, eventId: 44, replayed: false })); await flush();
  expect(nodes(render()).find(n => n.type === "alert")?.props.message).toContain("#44"); expect(busy.mock.calls.map(c => c[0])).toEqual([true, false]);
});
it("lost response survives unmount/refresh; only explicit retry reuses original payload despite changed inputs", async () => {
  fill(); fetchMock.mockRejectedValueOnce(new Error("lost")); click(); await flush();
  const first = payload(); check = null; remount(); expect(find("button").props.children).toBe("核对原保存结果");
  expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockResolvedValueOnce(Response.json({ itemId: 7, eventId: 45, replayed: true })); click("重试原产能请求"); await flush();
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(first); expect(nodes(render()).find(n => n.type === "alert")?.props.message).toContain("#45");
});
it("application conflict preserves original token; read-only missing result permits same-key correction", async () => {
  fill(); fetchMock.mockResolvedValueOnce(Response.json({ error: "产能依据已变化" }, { status: 409 })); click(); await flush();
  expect(find("textarea").props.value).toContain("真实交期"); expect(find("textarea").props.disabled).toBe(false);
  expect(find("button").props.children).toBe("核对原保存结果");
  const old = payload(); check = { ...check!, evidenceKey: "b".repeat(64) };
  fetchMock.mockResolvedValueOnce(Response.json({ itemId: 7, requestId: old.requestId, eventId: null })); click("核对原保存结果"); await flush();
  fetchMock.mockResolvedValueOnce(Response.json({ itemId: 7, requestId: old.requestId, eventId: null })).mockResolvedValueOnce(Response.json({ itemId: 7, eventId: 46, replayed: false }));
  click("核对后用当前情景修正原请求"); await flush();
  const next = JSON.parse(String(fetchMock.mock.calls[3][1]?.body)); expect(next.requestId).toBe(old.requestId); expect(next.evidenceKey).toBe("b".repeat(64));
});
it("malformed success is uncertain, not a false saved receipt", async () => {
  fill(); fetchMock.mockResolvedValueOnce(Response.json({ itemId: 999, eventId: 1, replayed: false })); click(); await flush();
  expect(find("button").props.children).toBe("核对原保存结果"); expect(fetchMock).toHaveBeenCalledOnce();
});

it("read-only recovery after refresh finds original record, then explicit acknowledgement clears only confirmed key", async () => {
  fill(); fetchMock.mockRejectedValueOnce(Error("lost")); click(); await flush(); const old = payload();
  check = null; remount(); expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockResolvedValue(Response.json({ itemId: 7, eventId: 47, requestId: old.requestId }));
  click("核对原保存结果"); await flush();
  expect(fetchMock.mock.calls[1][1]?.method).toBeUndefined(); expect(stored.size).toBe(1);
  // Supply a fresh Response body for the second independent confirmation GET.
  fetchMock.mockResolvedValueOnce(Response.json({ itemId: 7, eventId: 47, requestId: old.requestId }));
  click("确认记录，准备下一笔"); await flush(); expect(stored.size).toBe(0);
  expect(nodes(render()).find(n => n.type === "alert")?.props.message).toBe("当前没有待核对的产能保存请求");
});
it("corrupt storage or unsupported cross-tab lock blocks sending", async () => {
  stored.set("scm:capacity-handoff:v1:1", "{"); render(); fill(); expect(find("button").props.disabled).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled(); expect(stored.size).toBe(1);
  stored.clear(); remount(); fill(); vi.stubGlobal("navigator", {}); click(); await flush(); expect(fetchMock).not.toHaveBeenCalled();
});
it("an unmounted save leaves its request for recovery and never updates replacement UI", async () => {
  fill(); const p = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(p.promise); click();
  for (const cleanup of hooks.cleanups) cleanup();
  p.resolve(Response.json({ itemId: 7, eventId: 48, replayed: false })); await flush();
  expect(stored.size).toBe(1); expect(busy.mock.calls.map(c => c[0])).toEqual([true]);
});
