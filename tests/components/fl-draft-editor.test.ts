import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FlDraftEditor, { type EditableFlDraft } from "@/app/(app)/matflow/fl/fl-draft-editor";
import { JsonRequestError } from "@/components/fetchJson";

// Callback/lifecycle contract only. Real AntD layout and controls need browser acceptance.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanups: [] as (() => void)[], patch: vi.fn(), read: vi.fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Input: { TextArea: "textarea" }, InputNumber: "number", Modal: "modal", Space: "space", Table: "table", Typography: { Text: "text" } }));
vi.mock("@/components/RemoteSelect", () => ({ default: "select" }));
vi.mock("@/components/OutsourceWarehouseSelect", () => ({ default: "outsource-select" }));
vi.mock("@/components/fetchJson", async original => ({ ...await original<typeof import("@/components/fetchJson")>(), patchJson: h.patch, fetchJson: h.read }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial; return [h.slots[i], (v: unknown) => { h.slots[i] = typeof v === "function" ? v(h.slots[i]) : v; }]; },
  useEffect: (fn: () => (() => void)) => { const i = h.cursor++; if (!(i in h.slots)) { h.slots[i] = true; h.cleanups.push(fn()); } },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const doc: EditableFlDraft = { id: 19, docNo: "FL-19", version: 3, jgDocNo: "JG-8", supplierId: 4, fromWarehouseId: 1, toWarehouseId: 2, remark: null,
  lines: [{ skuId: 8, skuCode: "MAT", skuName: "物料", baseUom: "kg", qty: "1", batchId: 20, batchNo: "OLD", expiryDate: "2000-01-01" }] };
const saved = vi.fn(), close = vi.fn(), reload = vi.fn();
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function render() { h.cursor = 0; return FlDraftEditor({ doc, onSaved: saved, onClose: close, onReload: reload }); }
const modal = () => nodes(render()).find(n => n.type === "modal")!;
const save = () => (modal().props.onOk as () => void)();
const allocate = () => (nodes(render()).find(n => n.type === "button" && n.props.children === "按当前库存重新配批")!.props.onClick as () => void)();
beforeEach(() => { h.cursor = 0; h.slots = []; h.cleanups = []; h.patch.mockReset(); h.read.mockReset(); saved.mockReset(); close.mockReset(); reload.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { h.cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); });
it("double save makes one exact versioned write, with no JG reassignment", async () => {
  const task = Promise.withResolvers<unknown>(); h.patch.mockReturnValue(task.promise);
  save(); save(); expect(h.patch).toHaveBeenCalledTimes(1);
  expect(h.patch).toHaveBeenCalledWith("/api/matflow/fl/19", { version: 3, fromWarehouseId: 1, toWarehouseId: 2, remark: "", lines: [{ skuId: 8, qty: "1", batchId: 20 }] });
  task.resolve({ id: 19, version: 4, status: "draft" }); await flush(); expect(saved).toHaveBeenCalledTimes(1);
});
it.each([Error("网络结果不确定"), new JsonRequestError("版本已变化", 409)])("uncertain or conflicting write requires reload, never a second blind save", async error => {
  h.patch.mockRejectedValue(error); save(); await flush(); save(); await flush();
  expect(h.patch).toHaveBeenCalledTimes(1);
  expect(modal().props.okButtonProps).toMatchObject({ disabled: true });
  expect(saved).not.toHaveBeenCalled();
});
it("malformed successful response is not presented as saved", async () => {
  h.patch.mockResolvedValue({ id: 999, version: 4, status: "draft" }); save(); await flush();
  expect(saved).not.toHaveBeenCalled(); expect(modal().props.okButtonProps).toMatchObject({ disabled: true });
});
it("late successful write after unmount cannot refresh another document", async () => {
  const task = Promise.withResolvers<unknown>(); h.patch.mockReturnValue(task.promise);
  save(); h.cleanups.forEach(fn => fn()); task.resolve({ id: 19, version: 4, status: "draft" }); await flush();
  expect(saved).not.toHaveBeenCalled();
});
it("changing source warehouse blocks saving until explicit successful reallocation", async () => {
  (nodes(render()).find(n => n.type === "select")!.props.onChange as (id: number) => void)(3);
  save(); expect(h.patch).not.toHaveBeenCalled();
  h.read.mockResolvedValue({ skuId: 8, requestedQty: "1.0000", batchCoverage: true, shortBy: "0", fallbackQty: "0", note: "核对", allocations: [{ batchId: 21, batchNo: "NEW", expiryDate: "2999-01-01", qty: "1" }] });
  allocate(); await flush();
  expect(h.read.mock.calls[0][0]).toContain("warehouseId=3");
  expect(modal().props.okButtonProps).toMatchObject({ disabled: false });
  expect(nodes(render()).find(n => n.type === "table")!.props.dataSource).toMatchObject([{ batchId: 21 }]);
  expect(h.patch).not.toHaveBeenCalled();
});
it("failed preview retains original rows and does not enable save", async () => {
  h.read.mockRejectedValue(Error("读取超时")); allocate(); await flush();
  expect(nodes(render()).find(n => n.type === "table")!.props.dataSource).toMatchObject([{ batchId: 20, qty: "1" }]);
  expect(modal().props.okButtonProps).toMatchObject({ disabled: true });
  expect(h.patch).not.toHaveBeenCalled();
});
it("unmounted preview is aborted and cannot replace rows", async () => {
  const task = Promise.withResolvers<unknown>(); h.read.mockReturnValue(task.promise);
  allocate(); const signal = h.read.mock.calls[0][1].signal as AbortSignal;
  h.cleanups.forEach(fn => fn()); expect(signal.aborted).toBe(true);
  task.resolve({}); await flush(); expect(saved).not.toHaveBeenCalled();
});
