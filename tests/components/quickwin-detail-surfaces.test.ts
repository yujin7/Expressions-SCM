import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocActions from "@/components/DocActions";
import JgPrint from "@/app/(app)/outsource/jg/[id]/print/page";
import PoPrint from "@/app/(app)/outsource/po/[id]/print/page";
import CountPrint from "@/app/(app)/inventory/count/[id]/print/page";
import BomDiff from "@/app/(app)/master/bom/bom-diff-drawer";
import Identifiers from "@/app/(app)/master/sku/sku-identifiers-drawer";
import QcOutcome from "@/app/(app)/matflow/sh/qc-outcome-panel";
import Scoped from "@/app/(app)/admin/params/scoped-overrides-card";
const h = vi.hoisted(() => ({ read: vi.fn(), retry: vi.fn(), post: vi.fn(), state: [] as unknown[] }));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: h.read }));
vi.mock("@/components/fetchJson", () => ({ postJson: h.post, fetchJson: vi.fn(), patchJson: vi.fn() }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [h.state.length ? h.state.shift() : typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()],
  useEffect: vi.fn(), use: () => ({ id: "17" }),
}));
vi.mock("antd", () => ({
  App: { useApp: () => ({ message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }, modal: { confirm: vi.fn() } }) },
  Alert: "alert", Button: "button", Space: "space", Spin: "spin", Drawer: "drawer", Modal: "modal", Popconfirm: "confirm",
  Col: "col", Row: "row", Select: "select", Table: "table", Tag: "tag", Card: "card", Checkbox: "checkbox", Switch: "switch", InputNumber: "number",
  Empty: Object.assign("empty", { PRESENTED_IMAGE_SIMPLE: "empty" }),
  Input: Object.assign("input", { TextArea: "textarea" }), Descriptions: Object.assign("descriptions", { Item: "item" }),
  Typography: { Text: "text", Title: "title", Paragraph: "paragraph", Link: "a" },
  Form: Object.assign("form", { useForm: () => [{ resetFields: vi.fn(), setFieldsValue: vi.fn() }], useWatch: vi.fn(), Item: "item" }),
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const noop = () => {};
const params = Promise.resolve({ id: "17" });
const surfaces = [
  ["JG print", () => JgPrint({ params }), "/api/outsource/jg/17"],
  ["PO print", () => PoPrint({ params }), "/api/outsource/po/17"],
  ["count print", () => CountPrint({ params }), "/api/inventory/count/17"],
  ["BOM diff", () => BomDiff({ bomId: 17, title: "QA", open: true, onClose: noop }), "/api/master/bom/17/diff"],
  ["SKU identifiers", () => Identifiers({ sku: { id: 17, code: "QA", name: "QA" }, canWrite: true, onClose: noop }), "/api/master/sku/17/identifiers"],
  ["QC outcome", () => QcOutcome({ shId: 17, canWrite: true }), "/api/matflow/sh/17/qc-outcome"],
  ["scoped parameters", () => Scoped({ params: [], canWrite: true, selectedKey: "lead_days", onSelectKey: noop, onChanged: noop }), "/api/admin/params/scoped?key=lead_days"],
] as const;
beforeEach(() => {
  h.state = []; vi.clearAllMocks(); vi.stubGlobal("React", React);
  h.read.mockReturnValue({ data: null, phase: "error", error: "读取失败", retry: h.retry });
});
afterEach(() => vi.unstubAllGlobals());
it.each(surfaces)("%s binds the exact read identity and offers an explicit retry", (_name, render, url) => {
  const tree = render();
  expect(h.read).toHaveBeenCalledWith(url);
  const alert = nodes(tree).find(n => n.type === "alert" && n.props.action)!;
  expect(alert).toBeDefined();
  const retry = nodes(alert.props.action as ReactNode).find(n => n.type === "button")!;
  (retry.props.onClick as () => void)();
  expect(h.retry).toHaveBeenCalledOnce(); expect(h.post).not.toHaveBeenCalled();
});
it("closed BOM and SKU drawers disable reads", () => {
  BomDiff({ bomId: 17, title: "QA", open: false, onClose: noop });
  Identifiers({ sku: null, canWrite: true, onClose: noop });
  expect(h.read.mock.calls.map(c => c[0])).toEqual([null, null]);
});
const base = { id: 17, version: 2, subtype: "opening", reversalOfId: null };
it.each(["draft", "pending", "approved", "completed"])("stock %s without server action hints is read-only", status => {
  const tree = DocActions({ docType: "stock-doc", apiBase: "/api/inventory/stock-doc", doc: { ...base, status }, onChanged: noop });
  expect(nodes(tree).filter(n => n.type === "button")).toHaveLength(0);
});
it("pending stock with no approval authority offers withdrawal, not approve or reject", () => {
  const tree = DocActions({ docType: "stock-doc", apiBase: "/api/inventory/stock-doc", doc: { ...base, status: "pending",
    actions: { submit: false, withdraw: true, void: false, approve: false, shortClose: false, reverse: false, reason: "不可自审" } }, onChanged: noop });
  expect(nodes(tree).filter(n => n.type === "button").map(n => n.props.children)).toEqual(["撤回"]);
});
