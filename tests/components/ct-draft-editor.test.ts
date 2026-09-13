import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CtDraftEditor, { type EditableCtDraft } from "@/app/(app)/matflow/ct/ct-draft-editor";
import { JsonRequestError } from "@/components/fetchJson";

// Callback/lifecycle contract, not evidence of real AntD layout, focus or hydration.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanups: [] as (() => void)[], patch: vi.fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Input: Object.assign("input", { TextArea: "textarea" }), InputNumber: "number", Modal: "modal", Space: "space", Table: "table", Typography: { Text: "text" } }));
vi.mock("@/components/fetchJson", async original => ({ ...await original<typeof import("@/components/fetchJson")>(), patchJson: h.patch }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial; return [h.slots[i], (v: unknown) => { h.slots[i] = typeof v === "function" ? v(h.slots[i]) : v; }]; },
  useEffect: (fn: () => (() => void)) => { const i = h.cursor++; if (!(i in h.slots)) { h.slots[i] = true; h.cleanups.push(fn()); } },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const doc: EditableCtDraft = { id: 19, docNo: "CT-19", version: 3, poDocNo: "PO-8", warehouseName: "原仓", remark: null,
  lines: [{ id: 80, poLineId: 2, reason: "原原因", skuCode: "MAT", skuName: "物料", baseUom: "kg", qty: "1", batchId: 20, batchNo: "OLD", expiryDate: "2000-01-01" }] };
const saved = vi.fn(), close = vi.fn(), reload = vi.fn();
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function render() { h.cursor = 0; return CtDraftEditor({ doc, onSaved: saved, onClose: close, onReload: reload }); }
const modal = () => nodes(render()).find(n => n.type === "modal")!;
const save = () => (modal().props.onOk as () => void)();
function field(key: string) {
  const table = nodes(render()).find(n => n.type === "table")!;
  const columns = table.props.columns as { key: string; render: (_: unknown, row: unknown) => ReactNode }[];
  return nodes(columns.find(c => c.key === key)!.render(null, (table.props.dataSource as unknown[])[0]));
}
beforeEach(() => { h.cursor = 0; h.slots = []; h.cleanups = []; h.patch.mockReset(); saved.mockReset(); close.mockReset(); reload.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { h.cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); });
it("double save makes one versioned write, with no PO, warehouse, source or lot substitution", async () => {
  const task = Promise.withResolvers<unknown>(); h.patch.mockReturnValue(task.promise);
  save(); save(); expect(h.patch).toHaveBeenCalledTimes(1);
  expect(h.patch).toHaveBeenCalledWith("/api/matflow/ct/19", { version: 3, remark: "", lines: [{ id: 80, qty: "1", reason: "原原因" }] });
  (modal().props.onCancel as () => void)(); expect(close).not.toHaveBeenCalled();
  task.resolve({ id: 19, version: 4, status: "draft" }); await flush(); expect(saved).toHaveBeenCalledTimes(1);
});
it.each([Error("网络结果不确定"), new JsonRequestError("版本已变化", 409), new JsonRequestError("会话失效", 401)])("uncertain, conflicting or unauthenticated write requires reread", async error => {
  h.patch.mockRejectedValue(error); save(); await flush(); save(); await flush();
  expect(h.patch).toHaveBeenCalledTimes(1); expect(modal().props.okButtonProps).toMatchObject({ disabled: true });
  const alert = nodes(render()).find(n => n.type === "alert" && n.props.type === "error")!;
  expect(alert.props.message).toBe(error.message);
  const action = alert.props.action as Node; (action.props.onClick as () => void)(); expect(reload).toHaveBeenCalledOnce();
  expect(saved).not.toHaveBeenCalled();
});
it.each([{ id: 999, version: 4, status: "draft" }, { id: 19, version: 3, status: "draft" }, { id: 19, version: 4, status: "pending" }])("invalid success is not reported as saved", async result => {
  h.patch.mockResolvedValue(result); save(); await flush(); expect(saved).not.toHaveBeenCalled(); expect(modal().props.okButtonProps).toMatchObject({ disabled: true });
});
it("400 stays visible and permits an explicit corrected retry with exact four-place quantity", async () => {
  h.patch.mockRejectedValueOnce(new JsonRequestError("原因需要核对", 400)); save(); await flush();
  expect(nodes(render()).some(n => n.props.message === "原因需要核对")).toBe(true);
  const input = field("qty").find(n => n.type === "number")!;
  (input.props.onChange as (value: string) => void)("0.0001");
  h.patch.mockResolvedValue({ id: 19, version: 4, status: "draft" }); save(); await flush();
  expect(h.patch).toHaveBeenCalledTimes(2); expect(h.patch.mock.calls[1][1].lines[0].qty).toBe("0.0001"); expect(saved).toHaveBeenCalledOnce();
});
it("late save success after unmount cannot refresh another document", async () => {
  const task = Promise.withResolvers<unknown>(); h.patch.mockReturnValue(task.promise); save(); h.cleanups.forEach(fn => fn());
  task.resolve({ id: 19, version: 4, status: "draft" }); await flush(); expect(saved).not.toHaveBeenCalled();
});
it.each(["0", "", "1.12345", "10000000000"])("invalid quantity %s is rejected, never silently dropped", async value => {
  (field("qty").find(n => n.type === "number")!.props.onChange as (value: string) => void)(value);
  save(); await flush(); expect(h.patch).not.toHaveBeenCalled();
});
it("the final original row cannot be removed even if the disabled callback is invoked", () => {
  (field("remove")[0].props.onClick as () => void)();
  expect((nodes(render()).find(n => n.type === "table")!.props.dataSource as unknown[])).toHaveLength(1);
});
