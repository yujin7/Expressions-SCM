import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CtDraftVoid from "@/app/(app)/matflow/ct/ct-draft-void";
import { JsonRequestError } from "@/components/fetchJson";

// Callback/lifecycle contract, not evidence of real AntD layout, focus or hydration.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanups: [] as (() => void)[], post: vi.fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Input: Object.assign("input", { TextArea: "textarea" }), InputNumber: "number", Modal: "modal", Space: "space", Table: "table", Typography: { Text: "text" } }));
vi.mock("@/components/fetchJson", async original => ({ ...await original<typeof import("@/components/fetchJson")>(), postJson: h.post }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial; return [h.slots[i], (v: unknown) => { h.slots[i] = typeof v === "function" ? v(h.slots[i]) : v; }]; },
  useEffect: (fn: () => (() => void)) => { const i = h.cursor++; if (!(i in h.slots)) { h.slots[i] = true; h.cleanups.push(fn()); } },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const doc = { id: 19, docNo: "CT-19", version: 3 };
const saved = vi.fn(), close = vi.fn(), reload = vi.fn();
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function render() { h.cursor = 0; return CtDraftVoid({ doc, onSaved: saved, onClose: close, onReload: reload }); }
const modal = () => nodes(render()).find(n => n.type === "modal")!;
const save = () => (modal().props.onOk as () => void)();
function reason(value = "  原实物批次错误  ") {
  const input = nodes(render()).find(n => n.type === "textarea")!;
  (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}
beforeEach(() => { h.cursor = 0; h.slots = []; h.cleanups = []; h.post.mockReset(); saved.mockReset(); close.mockReset(); reload.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { h.cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); });
it("empty/oversized reason never writes; confirming twice sends one exact version and trimmed reason", async () => {
  save(); reason("x".repeat(501)); save(); expect(h.post).not.toHaveBeenCalled();
  reason(); const task = Promise.withResolvers<unknown>(); h.post.mockReturnValue(task.promise);
  save(); save(); expect(h.post).toHaveBeenCalledExactlyOnceWith("/api/matflow/ct/19/void", { version: 3, reason: "原实物批次错误" });
  (modal().props.onCancel as () => void)(); expect(close).not.toHaveBeenCalled();
  task.resolve({ id: 19, version: 4, status: "void", closedReason: "原实物批次错误" }); await flush();
  expect(saved).toHaveBeenCalledOnce();
});
it.each([Error("网络结果未知"), new JsonRequestError("版本变化", 409), new JsonRequestError("会话失效", 401), new JsonRequestError("服务器异常", 500)])("unknown or refused result requires reread without resend", async error => {
  reason(); h.post.mockRejectedValue(error); save(); await flush(); save(); await flush();
  expect(h.post).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled();
  expect(modal().props.okButtonProps).toMatchObject({ disabled: true });
  const alert = nodes(render()).find(n => n.type === "alert" && n.props.type === "error")!;
  expect(alert.props.message).toBe(error.message);
  ((alert.props.action as Node).props.onClick as () => void)(); expect(reload).toHaveBeenCalledOnce();
});
it.each([
  { id: 20, version: 4, status: "void", closedReason: "核对" },
  { id: 19, version: 3, status: "void", closedReason: "核对" },
  { id: 19, version: 4, status: "draft", closedReason: "核对" },
  { id: 19, version: 4, status: "void", closedReason: "其他原因" },
])("mismatched successful response cannot claim void completed", async result => {
  reason("核对"); h.post.mockResolvedValue(result); save(); await flush();
  expect(saved).not.toHaveBeenCalled(); expect(modal().props.okButtonProps).toMatchObject({ disabled: true });
});
it("400 allows explicit reason correction; never automatically retries", async () => {
  reason(); h.post.mockRejectedValueOnce(new JsonRequestError("请核对原因", 400)); save(); await flush();
  expect(h.post).toHaveBeenCalledOnce(); expect(modal().props.okButtonProps).toMatchObject({ disabled: false });
  reason("采购来源错误"); h.post.mockResolvedValue({ id: 19, version: 4, status: "void", closedReason: "采购来源错误" });
  save(); await flush(); expect(saved).toHaveBeenCalledOnce(); expect(h.post).toHaveBeenCalledTimes(2);
});
it("late success after leaving does not refresh another document", async () => {
  reason(); const task = Promise.withResolvers<unknown>(); h.post.mockReturnValue(task.promise); save();
  h.cleanups.forEach(fn => fn()); task.resolve({ id: 19, version: 4, status: "void", closedReason: "原实物批次错误" });
  await flush(); expect(saved).not.toHaveBeenCalled();
});
it("keeping the draft closes without a write", () => {
  reason(); (modal().props.onCancel as () => void)(); expect(close).toHaveBeenCalledOnce(); expect(h.post).not.toHaveBeenCalled();
});
