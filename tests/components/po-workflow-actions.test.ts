import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PoWorkflowActions from "@/app/(app)/outsource/po/po-workflow-actions";
import { JsonRequestError } from "@/components/fetchJson";
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanup: undefined as undefined | (() => void), changed: false, fetch: vi.fn(), read: vi.fn(), success: vi.fn(), refresh: vi.fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Modal: "modal", Space: "space", Input: { TextArea: "textarea" }, Typography: { Paragraph: "paragraph", Link: "link" }, App: { useApp: () => ({ message: { success: h.success } }) } }));
vi.mock("@/components/fetchJson", async original => ({ ...await original<typeof import("@/components/fetchJson")>(), fetchJson: h.fetch }));
vi.mock("@/components/doc-transition-recovery", () => ({ readClosingSnapshot: h.read }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = initial; return [h.slots[i], (v: T) => { if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useEffect: (fn: () => (() => void), deps: unknown[]) => { const i = h.cursor++; if (h.slots[i]) return; h.slots[i] = deps; h.effects.push(() => { h.cleanup = fn(); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children), ...nodes(v.props.description as ReactNode), ...nodes(v.props.action as ReactNode)] : [];
let props: Parameters<typeof PoWorkflowActions>[0];
function render(): ReactNode { for (let i = 0; i < 10; i++) { h.cursor = 0; h.changed = false; const tree = PoWorkflowActions(props); for (const f of h.effects.splice(0)) f(); if (!h.changed) return tree; } throw Error("render loop"); }
const button = (label: string) => nodes(render()).find(n => n.type === "button" && n.props.children === label);
const click = (label: string) => (button(label)!.props.onClick as () => void)();
const modal = () => nodes(render()).find(n => n.type === "modal")!;
const confirm = () => (modal().props.onOk as () => void)();
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); };
beforeEach(() => {
  h.slots = []; h.effects = []; h.cleanup = undefined; h.fetch.mockReset(); h.read.mockReset(); h.success.mockClear(); h.refresh.mockClear();
  props = { doc: { id: 3, docNo: "PO-3", status: "draft", version: 1, taskActions: { submit: true, approve: false, reject: false, withdraw: false, confirm: false, confirmToken: false, reason: "当前资格" } }, onChanged: h.refresh };
  vi.stubGlobal("React", React); vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:3464" } });
});
afterEach(() => { h.cleanup?.(); vi.unstubAllGlobals(); });
it("shows server-qualified actions only and refuses missing guidance", () => {
  expect(button("提交审批")).toBeDefined(); expect(button("审批通过")).toBeUndefined();
  props.doc.taskActions = null; expect(button("提交审批")).toBeUndefined();
});
it("same-tick double confirmation only posts once and locks cancel while waiting", async () => {
  click("提交审批"); const response = Promise.withResolvers<unknown>(); h.fetch.mockReturnValue(response.promise); confirm(); confirm();
  expect(h.fetch).toHaveBeenCalledTimes(1); expect(modal().props.closable).toBe(false); (modal().props.onCancel as () => void)(); expect(modal().props.open).toBe(true);
  h.read.mockResolvedValue({ status: "pending" }); response.resolve({ status: "pending" }); await flush();
  expect(h.read).toHaveBeenCalledWith("/api/outsource/po/3", "po", 3); expect(h.refresh).toHaveBeenCalledOnce();
});
it("successful POST followed by failed GET never retries the POST", async () => {
  click("提交审批"); h.fetch.mockResolvedValue({ status: "pending" }); h.read.mockRejectedValue(Error("read failed")); confirm(); await flush(); confirm();
  expect(h.fetch).toHaveBeenCalledTimes(1); expect(h.success).not.toHaveBeenCalled(); click("刷新核对，不重新提交"); expect(h.refresh).toHaveBeenCalledOnce();
});
it("R1 requires the machine code, not matching prose, to show the PC recovery link", async () => {
  click("提交审批"); h.fetch.mockRejectedValue(new JsonRequestError("价格异动", 409, "PO_PRICE_REVIEW_REQUIRED")); confirm(); await flush();
  expect(nodes(render()).some(n => n.type === "link" && n.props.href === "/outsource/pc")).toBe(true); expect(h.refresh).not.toHaveBeenCalled();
});
it("changed document version is rejected before any write", () => {
  click("提交审批"); props.doc = { ...props.doc, version: 2 }; render(); confirm(); expect(h.fetch).not.toHaveBeenCalled();
});
it("permission loss and unmount discard late success and do not refresh another document", async () => {
  click("提交审批"); const response = Promise.withResolvers<unknown>(); h.fetch.mockReturnValue(response.promise); confirm();
  props.doc = { ...props.doc, taskActions: null }; render(); response.resolve({ status: "pending" }); await flush(); expect(h.read).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
});
it("unmount while waiting does not emit a late result", async () => {
  click("提交审批"); const response = Promise.withResolvers<unknown>(); h.fetch.mockReturnValue(response.promise); confirm(); h.cleanup?.(); response.resolve({ status: "pending" }); await flush(); expect(h.success).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
});
it("confirmation link is shown only for the expected same-origin path and authorized actor", async () => {
  props.doc.taskActions!.confirmToken = true; click("生成供应商确认链接"); h.fetch.mockResolvedValue({ path: "https://attacker.invalid/token" }); confirm(); await flush();
  expect(nodes(render()).some(n => n.type === "paragraph" && n.props.copyable)).toBe(false);
});
it("valid generated link is explicit copyable output, not automatic clipboard or external navigation", async () => {
  props.doc.taskActions!.confirmToken = true; click("生成供应商确认链接"); h.fetch.mockResolvedValue({ path: "/supplier/confirm/7d0821a7-b0d0-4b39-8cb5-9ab456fc47c2" }); confirm(); await flush();
  expect(nodes(render()).find(n => n.type === "paragraph" && n.props.copyable)?.props.children).toBe("http://127.0.0.1:3464/supplier/confirm/7d0821a7-b0d0-4b39-8cb5-9ab456fc47c2");
  props.doc.taskActions!.confirmToken = false; expect(nodes(render()).some(n => n.type === "paragraph" && n.props.copyable)).toBe(false);
});
