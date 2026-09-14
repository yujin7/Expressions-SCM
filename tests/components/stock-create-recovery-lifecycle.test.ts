import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StockCreateRecovery, { useStockCreateRecovery } from "@/components/StockCreateRecovery";
import { prepareStockCreateRequest, stockCreateStorageKey } from "@/components/stock-create-request";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Popconfirm: "confirm", Space: "space", Typography: { Text: "text", Paragraph: "paragraph" } }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/DocStatusTag", () => ({ default: "status" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], (value: T) => { if (!Object.is(value, h.slots[i])) h.changed = true; h.slots[i] = value; }]; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const previous = h.slots[i] as readonly unknown[] | undefined;
    if (previous?.length === deps.length && previous.every((v, j) => Object.is(v, deps[j]))) return;
    h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
const key = "67f5bd82-42c9-4122-a031-cda1ba386e25", otherKey = "c3b95d49-63e2-419c-83d9-b7c0b430c256";
const payload = { subtype: "opening" as const, warehouseId: 10, lines: [{ skuId: 1, qty: "0.0001" }] };
const cancelled = { requestKey: key, document: null, cancelled: true };
const found = { requestKey: key, document: { id: 2, docNo: "RK-2", status: "draft" } };
const fetchMock = vi.fn<typeof fetch>(), onConfirmed = vi.fn(), onAcknowledged = vi.fn();
const storage = new Map<string, string>();
let allowed = true;
function RecoveryHarness() { return useStockCreateRecovery(1, allowed, onConfirmed); }
function render() { for (let i = 0; i < 10; i++) { h.cursor = 0; h.changed = false;
  const result = RecoveryHarness(); for (const effect of h.effects.splice(0)) effect();
  if (!h.changed) return result;
} throw Error("hook failed to settle"); }
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
function ui() { const tree = StockCreateRecovery({ recovery: render(), onEdit: vi.fn(), onAcknowledged }); return tree ? nodes(tree.props.description) : []; }
const button = (label: string) => ui().find(n => n.type === "button" && n.props.children === label)!;
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const unmount = () => { for (const cleanup of h.cleanups.values()) cleanup(); h.cleanups.clear(); };
beforeEach(() => {
  h.cursor = 0; h.slots = []; h.effects = []; h.changed = false; allowed = true; vi.clearAllMocks(); fetchMock.mockReset(); storage.clear();
  vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, value: string) => storage.set(k, value), removeItem: (k: string) => storage.delete(k) });
  vi.stubGlobal("navigator", { locks: { request: (_key: string, action: () => Promise<unknown>) => action() } });
  prepareStockCreateRequest(localStorage, 1, payload, undefined, () => key);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

it("restore and opening cancellation confirmation do not submit; confirmation is explicit", async () => {
  render(); expect(fetchMock).not.toHaveBeenCalled();
  const confirmation = ui().find(n => n.type === "confirm")!;
  expect(confirmation.props.okText).toBe("确认取消请求"); expect(button("取消原建单请求").props.onClick).toBeUndefined();
  fetchMock.mockResolvedValueOnce(Response.json({ requestKey: key, document: null })).mockResolvedValueOnce(Response.json(cancelled)).mockResolvedValueOnce(Response.json(cancelled));
  await (confirmation.props.onConfirm as () => Promise<unknown>)();
  expect(render().result).toEqual(cancelled); expect(storage.has(stockCreateStorageKey(1))).toBe(true);
  expect(button("重试原请求")).toBeUndefined(); expect(button("修正原请求")).toBeUndefined(); expect(onConfirmed).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(Response.json(cancelled));
  (button("确认取消，准备下一笔").props.onClick as () => void)(); await flush();
  expect(storage.size).toBe(0); expect(render().request).toBeNull(); expect(onAcknowledged).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
it("a lost cancellation response retains the request, and a later read recovers it without another POST", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ requestKey: key, document: null })).mockRejectedValueOnce(Error("lost reply"));
  await render().cancel(); expect(render().error).toBeTruthy(); expect(storage.size).toBe(1); expect(render().result).toBeNull();
  fetchMock.mockResolvedValueOnce(Response.json(cancelled)); await render().lookup();
  expect(render().result).toEqual(cancelled); expect(render().error).toBeNull(); expect(storage.size).toBe(1);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
it("created-first retains the original document and never posts cancellation or void", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(found)); await render().cancel();
  expect(render().result).toEqual(found); expect(onConfirmed).toHaveBeenCalledOnce();
  expect(ui().find(n => n.type === "a")?.props.href).toBe("/inventory/docs?docId=2");
  expect(fetchMock).toHaveBeenCalledOnce(); expect(storage.size).toBe(1);
});
it("edit lookup discovering cancellation cannot update the payload or POST", async () => {
  const before = storage.get(stockCreateStorageKey(1)); fetchMock.mockResolvedValueOnce(Response.json(cancelled));
  await render().submit({ ...payload, warehouseId: 12 }, true);
  expect(render().result).toEqual(cancelled); expect(storage.get(stockCreateStorageKey(1))).toBe(before);
  expect(fetchMock).toHaveBeenCalledOnce();
});
it("acknowledgement failure does not clear local intent or reset the form", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(cancelled)); await render().lookup();
  fetchMock.mockRejectedValueOnce(Error("read unavailable")); (button("确认取消，准备下一笔").props.onClick as () => void)(); await flush();
  expect(storage.size).toBe(1); expect(onAcknowledged).not.toHaveBeenCalled(); expect(render().error).toBeTruthy();
});
it("a newer local request cannot be cleared by acknowledgement of the old result", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(cancelled)); await render().lookup();
  storage.set(stockCreateStorageKey(1), JSON.stringify({ ...payload, requestKey: otherKey }));
  fetchMock.mockResolvedValueOnce(Response.json(cancelled)); (button("确认取消，准备下一笔").props.onClick as () => void)(); await flush();
  expect(render().request?.requestKey).toBe(otherKey); expect(onAcknowledged).not.toHaveBeenCalled(); expect(storage.size).toBe(1);
});
it("changed local intent rejects cancellation before network access", async () => {
  const recovery = render(); storage.set(stockCreateStorageKey(1), JSON.stringify({ ...payload, requestKey: otherKey }));
  await recovery.cancel(); expect(fetchMock).not.toHaveBeenCalled(); expect(render().error).toContain("原请求已变化");
});
it.each(["unmount", "permission"])("late cancellation cannot confirm after %s", async change => {
  const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
  const action = render().cancel(); await flush();
  if (change === "unmount") unmount(); else { allowed = false; render(); }
  pending.resolve(Response.json(cancelled)); expect(await action).toBeNull();
  expect(onConfirmed).not.toHaveBeenCalled(); expect(storage.size).toBe(1);
});
it("synchronous repeated clicks share one in-flight cancellation", async () => {
  const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
  const recovery = render(), first = recovery.cancel(), duplicate = recovery.cancel(); await flush();
  expect(fetchMock).toHaveBeenCalledOnce(); pending.resolve(Response.json(cancelled)); await Promise.all([first, duplicate]);
  expect(render().result).toEqual(cancelled); expect(storage.size).toBe(1);
});
