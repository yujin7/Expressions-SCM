import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TlDraftEditor, { type EditableTlDraft } from "@/app/(app)/matflow/tl/tl-draft-editor";
import { JsonRequestError } from "@/components/fetchJson";

// Callback/lifecycle contract only. Real AntD layout and controls need browser acceptance.
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], cleanups: [] as (() => void)[], patch: vi.fn(), read: vi.fn() }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Input: { TextArea: "textarea" }, InputNumber: "number", Select: "reason-select", Modal: "modal", Space: "space", Table: "table", Typography: { Text: "text" } }));
vi.mock("@/components/RemoteSelect", () => ({ default: "select" }));
vi.mock("@/components/fetchJson", async original => ({ ...await original<typeof import("@/components/fetchJson")>(), patchJson: h.patch, fetchJson: h.read }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial; return [h.slots[i], (v: unknown) => { h.slots[i] = typeof v === "function" ? v(h.slots[i]) : v; }]; },
  useEffect: (fn: () => (() => void)) => { const i = h.cursor++; if (!(i in h.slots)) { h.slots[i] = true; h.cleanups.push(fn()); } },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const doc: EditableTlDraft = { id: 19, docNo: "TL-19", version: 3, jgDocNo: "JG-8", fromWarehouseName: "原委外仓", toWarehouseId: 2, remark: null,
  lines: [{ id: 80, reason: "surplus_return", skuCode: "MAT", skuName: "物料", baseUom: "kg", qty: "1", batchId: 20, batchNo: "OLD", expiryDate: "2000-01-01" }] };
const saved = vi.fn(), close = vi.fn(), reload = vi.fn();
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function render() { h.cursor = 0; return TlDraftEditor({ doc, onSaved: saved, onClose: close, onReload: reload }); }
const modal = () => nodes(render()).find(n => n.type === "modal")!;
const save = () => (modal().props.onOk as () => void)();
beforeEach(() => { h.cursor = 0; h.slots = []; h.cleanups = []; h.patch.mockReset(); h.read.mockReset(); saved.mockReset(); close.mockReset(); reload.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { h.cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); });
it("double save makes one exact versioned write, with no JG reassignment", async () => {
  const task = Promise.withResolvers<unknown>(); h.patch.mockReturnValue(task.promise);
  save(); save(); expect(h.patch).toHaveBeenCalledTimes(1);
  expect(h.patch).toHaveBeenCalledWith("/api/matflow/tl/19", { version: 3, toWarehouseId: 2, remark: "", lines: [{ id: 80, qty: "1", reason: "surplus_return" }] });
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

it("wrong quantity is reported without silently dropping the line", async () => {
  const table = nodes(render()).find(n => n.type === "table")!;
  const row = (table.props.dataSource as unknown[])[0];
  const columns = table.props.columns as {key: string;render: (_: unknown,row: unknown) => ReactNode}[];
  const input = nodes(columns.find(c => c.key === "qty")!.render(null,row)).find(n => n.type === "number")!;
  (input.props.onChange as (value: string) => void)("0");
  save(); await flush(); expect(h.patch).not.toHaveBeenCalled();
});
it("expired original lot has no auto-reallocation or source/batch substitution control", () => {
  const all = nodes(render());
  expect(all.filter(n => n.type === "select")).toHaveLength(1);
  expect(h.read).not.toHaveBeenCalled();
  expect(all.some(n => n.type === "button" && String(n.props.children).includes("配批"))).toBe(false);
});
