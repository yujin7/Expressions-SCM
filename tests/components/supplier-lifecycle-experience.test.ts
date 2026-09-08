import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SupplierLifecycleClient from "@/app/(app)/master/supplier/lifecycle/supplier-lifecycle-client";

const h = vi.hoisted(() => ({ cursor: 0, formCursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
const state = vi.hoisted(() => ({ desktop: false, buyer: true, caseId: "", error: null as string | null }));
const send = vi.hoisted(() => vi.fn());
const reload = vi.hoisted(() => vi.fn());
const forms = vi.hoisted(() => [0, 1, 2].map(() => ({ values: {} as Record<string, unknown>, resetFields() { this.values = {}; },
  setFieldsValue(v: Record<string, unknown>) { Object.assign(this.values, v); }, setFieldValue(k: string, v: unknown) { this.values[k] = v; },
  async validateFields() { return this.values; } })));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], (v: unknown) => { h.slots[i] = typeof v === "function" ? v(h.slots[i]) : v; h.changed = true; }]; },
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => { const i = h.cursor++; const prior = h.slots[i] as unknown[] | undefined;
    if (prior?.length === deps.length && prior.every((v, j) => Object.is(v, deps[j]))) return;
    h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Card: "card", Col: "col", DatePicker: "date", Grid: { useBreakpoint: () => ({ lg: state.desktop }) },
  Input: { TextArea: "textarea" }, InputNumber: "number", Modal: "modal", Row: "row", Select: "select", Space: "space", Statistic: "statistic", Switch: "switch", Table: "table", Tag: "tag",
  Typography: { Text: "text", Paragraph: "paragraph", Title: "title", Link: "a" },
  App: { useApp: () => ({ message: { success: vi.fn() } }) },
  Form: Object.assign("form", { Item: "item", useForm: () => [forms[h.formCursor++]], useWatch: (key: string, form: typeof forms[number]) => form.values[key] }),
}));
vi.mock("@/components/supplier-lifecycle-request", async original => ({ ...await original<typeof import("@/components/supplier-lifecycle-request")>(), submitSupplierWork: send }));
vi.mock("@/components/useMe", () => ({ useMe: () => ({ id: 3 }), hasAnyRole: () => state.buyer }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { q: "", status: "open", kind: "payment_term", caseId: state.caseId }, queryString: () => "kind=payment_term", setFilter: vi.fn(), paginationProps: () => ({}), tableSize: "small" }) }));
vi.mock("@/components/useDocumentRead", () => ({ useDocumentRead: () => ({ data: state.error ? null : { rows: [], owners: [{ id: 3, name: "采购" }], summary: { open: 1, overdue: 0, admissions: 0, corrective: 0, negotiations: 1 }, total: 1 }, error: state.error, phase: state.error ? "error" : "success", retry: reload }) }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/CaliberNote", () => ({ default: "caliber" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "load-error" }));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const text = (v: ReactNode): string => typeof v === "string" || typeof v === "number" ? String(v) : Array.isArray(v) ? v.map(text).join("") : isValidElement<Node["props"]>(v) ? text(v.props.children) : "";
function render() { for (let n = 0; n < 10; n++) { h.cursor = 0; h.formCursor = 0; h.changed = false; const tree = SupplierLifecycleClient(); for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return nodes(tree); } throw new Error("render did not settle"); }
const modal = () => render().find(n => n.type === "modal" && n.props.open)!;
const row = { id: 5, supplierId: 7, supplierName: "合成供应商", supplierCode: "QA", kind: "payment_term", status: "open", priority: "normal", ownerId: 3, dueDate: "2099-12-31", version: 4, targetCreditDays: 60, termBaseline: null, termCurrent: null, reason: "完整发起依据".repeat(30) };
function action(label: string) {
  const table = render().find(n => n.type === "table")!;
  const columns = table.props.columns as { key?: string; render?: (v: unknown, r: unknown) => ReactNode }[];
  const column = state.desktop ? columns.find(c => c.key === "actions")! : columns[0];
  const button = nodes(column.render!(null, row)).find(n => n.type === "button" && text(n.props.children) === label)!;
  (button.props.onClick as () => void)();
}
beforeEach(() => { vi.stubGlobal("React", React); h.cursor = 0; h.slots = []; h.effects = []; h.cleanups.clear(); state.desktop = false; state.buyer = true; state.caseId = ""; state.error = null; forms.forEach(f => f.resetFields()); send.mockReset(); reload.mockClear(); });
afterEach(() => { for (const cleanup of h.cleanups.values()) cleanup(); vi.unstubAllGlobals(); });
it("关案后保留准确回执和不受进行中筛选影响的历史链接", async () => {
  action("记录结果"); forms[1].values = { outcome: "failed", closureNote: "本轮未取得实际协议" };
  send.mockResolvedValue({ id: 5, status: "closed" }); await (modal().props.onOk as () => Promise<void>)();
  // onOk starts the async callback; settle its promises before reading state.
  await Promise.resolve(); await Promise.resolve();
  const receipt = render().find(n => n.props.className === "supplier-work-receipt")!;
  expect(receipt).toBeDefined(); expect(String(receipt.props.message)).toContain("#5");
  expect(nodes(receipt.props.description as ReactNode).find(n => n.type === "a")?.props.href).toBe("/master/supplier/lifecycle?caseId=5&status=");
  expect(reload).toHaveBeenCalledTimes(1);
});
it("失败原因持续可见，输入与版本保持，用户重试不偷偷采纳新版本", async () => {
  action("跟进"); forms[2].values.note = "继续核实实际协议";
  send.mockRejectedValueOnce(new Error("主档变化，请核对")); (modal().props.onOk as () => void)();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(modal()).toBeDefined();
  const error = nodes(modal().props.children).find(n => n.type === "alert" && n.props.type === "error")!;
  expect(text(error.props.description as ReactNode)).toContain("主档变化，请核对"); expect(forms[2].values.note).toBe("继续核实实际协议");
  send.mockResolvedValueOnce({ id: 5, status: "open" }); (modal().props.onOk as () => void)();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(send.mock.calls.map(c => c[2].expectedVersion)).toEqual([4, 4]);
});
it("弹窗由父页面持有，长标题自然排版、正文收缩滚动、页脚不被挤出", () => {
  action("记录结果"); forms[1].values.closureNote = "跨宽度保留的依据"; state.desktop = true;
  expect(modal().props.open).toBe(true); expect(forms[1].values.closureNote).toBe("跨宽度保留的依据");
  expect(modal().props.styles).toMatchObject({ content: { display: "flex", maxHeight: "calc(100dvh - 48px)" }, body: { minHeight: 0, overflowY: "auto" }, footer: { flexShrink: 0 } });
});
it("离开页面后迟到的写回执不能触发刷新或新页面成功提示", async () => {
  action("记录结果"); forms[1].values = { outcome: "failed", closureNote: "本轮未取得实际协议" };
  const pending = Promise.withResolvers<unknown>(); send.mockReturnValue(pending.promise); (modal().props.onOk as () => void)(); await Promise.resolve();
  for (const cleanup of h.cleanups.values()) cleanup(); pending.resolve({ id: 5, status: "closed" });
  for (let i = 0; i < 10; i++) await Promise.resolve(); expect(reload).not.toHaveBeenCalled();
});
it("准确链接默认展开记录；窄屏没有遮挡身份的固定列", () => {
  state.caseId = "5"; const table = render().find(n => n.type === "table")!;
  expect(table.props.expandable).toMatchObject({ expandedRowKeys: [5] }); expect(table.props.scroll).toEqual({ x: undefined });
  expect(table.props.columns).toHaveLength(1);
});
it("窄屏列表只显示协议摘要，完整原因有明确展开按钮，不重复铺开长协议", () => {
  const table = render().find(n => n.type === "table")!;
  const columns = table.props.columns as { render: (v: unknown, r: unknown) => ReactNode }[];
  const card = nodes(columns[0].render(null, row));
  expect(text(card.map(n => n.props.children))).not.toContain(row.reason);
  expect(card.find(n => n.props.summaryOnly === true)).toBeDefined();
  const toggle = card.find(n => n.type === "button" && text(n.props.children) === "完整依据与记录")!;
  expect(toggle.props["aria-expanded"]).toBe(false);
  (toggle.props.onClick as () => void)();
  const updated = render().find(n => n.type === "table")!;
  expect(updated.props.expandable).toMatchObject({ expandedRowKeys: [5] });
});

it("历史游标由页面按工作项和版本持有，跨响应式表格重建不跳回最新页", () => {
  const evidence = (record = row) => {
    const table = render().find(n => n.type === "table")!;
    const expanded = table.props.expandable as { expandedRowRender: (record: typeof row) => Node };
    return expanded.expandedRowRender(record);
  };
  expect(evidence().props.cursor).toBeNull();
  (evidence().props.onCursorChange as (cursor: number | null) => void)(123);
  state.desktop = true;
  expect(evidence().props.cursor).toBe(123);
  state.desktop = false;
  expect(evidence().props.cursor).toBe(123);
  expect(evidence({ ...row, id: 6 }).props.cursor).toBeNull();
  expect(evidence({ ...row, version: 5 }).props.cursor).toBeNull();
  (evidence().props.onCursorChange as (cursor: number | null) => void)(null);
  expect(evidence().props.cursor).toBeNull();
});
