import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WoCreateDialog from "@/app/(app)/outsource/wo/wo-create-dialog";
import { loadWoCreateRequest } from "@/components/wo-create-request";

// Callback/lifecycle proof; AntD layout is separately checked in the isolated browser.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false,
  values: {} as Record<string, unknown>, setField: vi.fn(), validate: vi.fn(), fetch: vi.fn(), close: vi.fn(), resume: vi.fn(), created: vi.fn(),
  reset: vi.fn(), listeners: new Map<string, (event: unknown) => void>(),
}));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Modal: "modal", Space: "space", Select: "select", DatePicker: "date", InputNumber: "number",
  Input: Object.assign("input", { TextArea: "textarea" }),
  Form: Object.assign("form", { Item: "form-item", useForm: () => [{ resetFields: h.reset, setFieldValue: h.setField, setFieldsValue: (v: Record<string, unknown>) => { h.values = v; }, validateFields: h.validate }] }),
}));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote" }));
vi.mock("@/components/DocStatusTag", () => ({ default: "status" }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: h.fetch }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const old = h.slots[i] as readonly unknown[] | undefined;
    if (old?.length === deps.length && old.every((v, j) => Object.is(v, deps[j]))) return;
    h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children), ...nodes(v.props.description as ReactNode)] : [];
const key = "ee392149-8738-4e50-992f-f565bba7f911";
const payload = { productSkuId: 7, supplierId: 8, qty: "3.0001", feeRatePlan: "1.25" };
const receipt = { requestKey: key, document: { id: 17, docNo: "WO-20260913-0001", status: "draft" } };
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
let props: Parameters<typeof WoCreateDialog>[0];
function render(): ReactNode {
  for (let i = 0; i < 10; i++) { h.cursor = 0; h.changed = false; const tree = WoCreateDialog(props);
    for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return tree; }
  throw Error("render did not settle");
}
const dialog = () => nodes(render()).find(n => n.type === "modal")!;
const button = (text: string) => nodes(render()).find(n => n.type === "button" && n.props.children === text)!;
const click = (text: string) => (button(text).props.onClick as () => void)();
const submit = () => (dialog().props.onOk as () => void)();
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); render(); };
const unmount = () => { for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); };
const persist = () => data.set("scm:wo-create:v1:1", JSON.stringify({ ...payload, requestKey: key }));
beforeEach(() => {
  h.slots = []; h.effects = []; h.listeners.clear(); data = new Map();
  props = { actorId: 1, allowed: true, open: true, onClose: h.close, onResume: h.resume, onCreated: h.created };
  h.values = { ...payload }; h.reset.mockReset(); h.fetch.mockReset(); h.validate.mockReset().mockImplementation(async () => h.values);
  h.close.mockClear(); h.resume.mockClear(); h.created.mockClear(); h.setField.mockClear();
  vi.stubGlobal("React", React); vi.stubGlobal("localStorage", storage); vi.stubGlobal("crypto", { randomUUID: () => key });
  vi.stubGlobal("window", { addEventListener: (name: string, fn: (event: unknown) => void) => h.listeners.set(name, fn), removeEventListener: (name: string) => h.listeners.delete(name) });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, fn: () => Promise<unknown>) => fn() } });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

it("BH source remains bounded and clears manual type; decimal inputs preserve strings", () => {
  const all = nodes(render()); const source = all.find(n => n.type === "remote" && n.props.api === "/api/outsource/bh?status=approved")!;
  expect(source).toBeDefined(); expect((source.props.getLabel as (r: Record<string, unknown>) => string)({ docNo: "BH-001", orderType: null })).toBe("BH-001");
  (source.props.onChange as () => void)(); expect(h.setField).toHaveBeenLastCalledWith("orderType", undefined);
  expect(all.filter(n => n.type === "number").map(n => n.props.stringMode)).toEqual([true, true]);
});
it("same-tick submit locks before validation and stores intent before HTTP", async () => {
  render(); const validation = Promise.withResolvers<Record<string, unknown>>(); const write = Promise.withResolvers<unknown>();
  h.validate.mockReturnValue(validation.promise); h.fetch.mockReturnValue(write.promise); submit(); submit();
  expect(h.validate).toHaveBeenCalledTimes(1); expect(dialog().props.closable).toBe(false);
  (dialog().props.onCancel as () => void)(); expect(h.close).not.toHaveBeenCalled();
  validation.resolve(payload); await flush(); expect(h.fetch).toHaveBeenCalledTimes(1); expect(loadWoCreateRequest(storage, 1)?.requestKey).toBe(key);
  write.resolve(receipt); await flush(); expect(h.created).toHaveBeenCalledTimes(1); expect(h.close).toHaveBeenCalledTimes(1);
  expect(loadWoCreateRequest(storage, 1)).not.toBeNull();
  expect(nodes(render()).find(n => n.type === "a")?.props.href).toBe("/outsource/wo?docId=17");
});
it("lost response survives remount; recovery is read-only and acknowledgement rechecks before clearing", async () => {
  render(); h.fetch.mockRejectedValueOnce(Error("lost response")); submit(); await flush();
  expect(h.created).not.toHaveBeenCalled(); expect(loadWoCreateRequest(storage, 1)).not.toBeNull();
  unmount(); h.slots = []; h.effects = []; render(); expect(h.fetch).toHaveBeenCalledTimes(1);
  h.fetch.mockResolvedValue(receipt); click("核对创建结果"); await flush();
  expect(h.fetch.mock.calls[1][1].method).toBeUndefined(); expect(h.created).toHaveBeenCalledTimes(1);
  click("已核对，准备新工单"); await flush(); expect(h.fetch).toHaveBeenCalledTimes(3); expect(loadWoCreateRequest(storage, 1)).toBeNull();
});
it("restored retry ignores edited form values and sends the exact original payload", async () => {
  persist(); render(); h.values = { ...payload, qty: "999" }; h.fetch.mockResolvedValue(receipt);
  click("重试原请求"); await flush(); expect(h.validate).not.toHaveBeenCalled();
  expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toEqual({ ...payload, requestKey: key });
});
it("not-found permits deliberate editing but keeps the original request key", async () => {
  persist(); render(); h.fetch.mockResolvedValueOnce({ requestKey: key, document: null }); click("核对创建结果"); await flush();
  click("修改未确认请求"); render(); h.values = { ...payload, qty: "4" }; h.fetch.mockResolvedValue(receipt); submit(); await flush();
  expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toMatchObject({ requestKey: key, qty: "4" }); expect(h.resume).toHaveBeenCalledTimes(1);
});
it("failed acknowledgement cannot discard the receipt", async () => {
  persist(); render(); h.fetch.mockResolvedValueOnce(receipt); click("核对创建结果"); await flush();
  h.fetch.mockResolvedValueOnce({ requestKey: key, document: null }); click("已核对，准备新工单"); await flush();
  expect(loadWoCreateRequest(storage, 1)).not.toBeNull(); expect(h.close).not.toHaveBeenCalled();
});
it("unmount during creation suppresses callbacks but retains recoverable intent", async () => {
  render(); const write = Promise.withResolvers<unknown>(); h.fetch.mockReturnValue(write.promise); submit(); await flush(); unmount();
  write.resolve(receipt); await flush(); expect(h.created).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled(); expect(loadWoCreateRequest(storage, 1)).not.toBeNull();
});
it("permission loss during acknowledgement cannot clear account recovery data", async () => {
  persist(); render(); h.fetch.mockResolvedValueOnce(receipt); click("核对创建结果"); await flush();
  const check = Promise.withResolvers<unknown>(); h.fetch.mockReturnValue(check.promise); click("已核对，准备新工单");
  props.allowed = false; render(); check.resolve(receipt); await flush(); expect(loadWoCreateRequest(storage, 1)).not.toBeNull();
  props.allowed = true; expect(dialog().props.confirmLoading).toBe(false);
});
it("unrelated storage events do not erase a typed draft; own-account events restore it", () => {
  render(); const count = h.reset.mock.calls.length;
  h.listeners.get("storage")!({ storageArea: storage, key: "another-page" }); render(); expect(h.reset).toHaveBeenCalledTimes(count);
  persist(); h.listeners.get("storage")!({ storageArea: storage, key: "scm:wo-create:v1:1" }); render(); expect(h.values).toMatchObject({ requestKey: key });
});
it("invalid local recovery blocks new submission and is never silently deleted", async () => {
  data.set("scm:wo-create:v1:1", "{"); render(); expect(dialog().props.okButtonProps).toEqual({ disabled: true });
  submit(); await flush(); expect(h.fetch).not.toHaveBeenCalled(); expect(data.get("scm:wo-create:v1:1")).toBe("{");
});
it("long forms keep the footer in the viewport and reveal recovery feedback after a failure", async () => {
  const body = nodes(render()).find(n => n.type === "div" && n.props.ref)!;
  expect(body.props.style).toMatchObject({ maxHeight: "calc(100dvh - 180px)", overflowY: "auto" });
  expect(dialog().props.style).toEqual({ top: 24 });
  const element = { scrollTop: 250 }; (body.props.ref as { current: unknown }).current = element;
  h.fetch.mockRejectedValueOnce(Error("lost response")); submit(); await flush(); expect(element.scrollTop).toBe(0);
});
