import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocActions from "@/components/DocActions";
import { JsonRequestError } from "@/components/fetchJson";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanup: undefined as undefined | (() => void),
  command: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("@/components/stock-doc-command", () => ({ postStockDocCommand: h.command }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Input: { TextArea: "textarea" }, Modal: "modal", Popconfirm: "confirm", Space: "space",
  App: { useApp: () => ({ message: { success: h.success, warning: h.warning } }) } }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], (value: T) => { h.slots[i] = value; }]; },
  useEffect: (fn: () => (() => void)) => { const i = h.cursor++; if (!(i in h.slots)) { h.slots[i] = true; h.cleanup = fn(); } },
}));
const changed = vi.fn();
let status = "draft";
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
function render() { h.cursor = 0; return nodes(DocActions({ docType: "stock-doc", apiBase: "/api/inventory/stock-doc", onChanged: changed,
  doc: { id: 7, docNo: "RK-EXACT-007", status, version: 2, subtype: "opening", reversalOfId: null,
    actions: { submit: true, void: true, withdraw: true, approve: true, shortClose: true, reverse: true, reason: null } } })); }
const button = (label: string) => render().find(n => n.type === "button" && n.props.children === label)!;
const modal = () => render().find(n => n.type === "modal" && n.props.open)!;
const click = (node: Node) => (node.props.onClick as () => void)();
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function openReason(label = "作废") {
  click(button(label));
  const input = render().find(n => n.type === "textarea")!;
  (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "核对错仓后退出" } });
}
beforeEach(() => { h.cursor = 0; h.slots = []; h.cleanup = undefined; status = "draft"; vi.clearAllMocks(); h.command.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { h.cleanup?.(); vi.unstubAllGlobals(); });

it("explicit confirmation identifies the exact original and synchronous double clicks only post once", async () => {
  openReason(); const dialog = modal(); expect(dialog.props.title).toContain("RK-EXACT-007");
  expect(dialog.props.style).toMatchObject({ maxWidth: "calc(100vw - 32px)" });
  expect(h.command).not.toHaveBeenCalled();
  const held = Promise.withResolvers<unknown>(); h.command.mockReturnValueOnce(held.promise);
  (dialog.props.onOk as () => void)(); (dialog.props.onOk as () => void)();
  expect(h.command).toHaveBeenCalledOnce();
  expect(h.command.mock.calls[0]).toMatchObject({ 2: "void", 3: { version: 2, reason: "核对错仓后退出" } });
  expect(button("作废").props.disabled).toBe(true);
  (modal().props.onCancel as () => void)(); expect(modal()).toBeDefined();
  held.resolve({}); await flush(); expect(changed).toHaveBeenCalledOnce(); expect(h.success).toHaveBeenCalledOnce();
});
it("uncertain reply retains reason, blocks writes and offers only a current-state read", async () => {
  openReason(); h.command.mockRejectedValueOnce(Error("响应未知，请核对原单状态"));
  (modal().props.onOk as () => void)(); await flush();
  expect(h.success).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  expect(render().filter(n => n.type === "alert")).toHaveLength(1);
  expect(render().find(n => n.type === "textarea")?.props).toMatchObject({ value: "核对错仓后退出", disabled: true });
  (modal().props.onOk as () => void)(); expect(h.command).toHaveBeenCalledOnce();
  const alert = render().find(n => n.type === "alert")!; click(alert.props.action as Node);
  expect(changed).toHaveBeenCalledOnce(); expect(h.command).toHaveBeenCalledOnce(); expect(h.success).not.toHaveBeenCalled();
});
it("validation 400 permits correction while conflicts require a fresh read", async () => {
  openReason(); h.command.mockRejectedValueOnce(new JsonRequestError("原因不合法", 400));
  (modal().props.onOk as () => void)(); await flush();
  expect(render().find(n => n.type === "textarea")?.props.disabled).toBe(false);
  h.command.mockRejectedValueOnce(new JsonRequestError("版本冲突", 409));
  (modal().props.onOk as () => void)(); await flush();
  expect(render().find(n => n.type === "textarea")?.props.disabled).toBe(true);
  expect(h.command).toHaveBeenCalledTimes(2); expect(h.success).not.toHaveBeenCalled();
});
it.each(["resolve", "reject"])("late %s after unmount cannot notify or refresh another detail", async outcome => {
  openReason(); const held = Promise.withResolvers<unknown>(); h.command.mockReturnValueOnce(held.promise);
  (modal().props.onOk as () => void)(); h.cleanup?.();
  if (outcome === "resolve") held.resolve({}); else held.reject(Error("late"));
  await flush(); expect(changed).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled();
});
it("short close sends only remaining-work closure with the required reason", async () => {
  status = "in_progress"; openReason("短关"); h.command.mockResolvedValueOnce({});
  (modal().props.onOk as () => void)(); await flush();
  expect(h.command.mock.calls[0]).toMatchObject({ 2: "short-close", 3: { version: 2, reason: "核对错仓后退出" } });
  expect(h.success).toHaveBeenCalledWith("单据已短关");
});
