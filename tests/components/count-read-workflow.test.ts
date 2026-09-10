import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CountClient from "@/app/(app)/inventory/count/count-client";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false,
  q: "", period: "", detailId: null as number | null, setId: vi.fn(), validate: vi.fn(), message: { error: vi.fn(), success: vi.fn() } }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: h.message }) }, Alert: "alert", Tag: "tag", Button: "button", Modal: "modal", Space: "space", Table: "table", Tabs: "tabs", Popconfirm: "confirm", Select: "select", InputNumber: "number", Radio: { Group: "radio", Button: "radio-button" },
  Form: Object.assign("form", { useForm: () => [{ validateFields: h.validate, resetFields: vi.fn(), setFieldsValue: vi.fn() }], useWatch: () => "partial", Item: "item" }),
  Input: Object.assign("input", { TextArea: "textarea" }), Descriptions: Object.assign("descriptions", { Item: "item" }), Typography: { Title: "title", Paragraph: "paragraph", Link: "a", Text: "text" } }));
vi.mock("@ant-design/icons", () => ({ PlusOutlined: "plus", ReloadOutlined: "reload", PrinterOutlined: "printer", SaveOutlined: "save" }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "read-error" }));
vi.mock("@/components/DocumentDrawer", () => ({ default: "drawer" }));
vi.mock("@/components/DocStatusTag", () => ({ default: "status" }));
vi.mock("@/components/ApprovalTimeline", () => ({ default: "timeline" }));
vi.mock("@/components/ScannerEntry", () => ({ default: "scanner" }));
vi.mock("@/components/ExportButton", () => ({ default: "export" }));
vi.mock("@/components/useDocumentTarget", () => ({ useDocumentTarget: () => ({ id: h.detailId, setId: h.setId, present: h.detailId !== null }) }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { q: h.q, status: "", mode: "", period: h.period }, page: 1, pageSize: 20, tableSize: "small", paginationProps: (v: unknown) => v,
  setFilter: (patch: { period?: string }) => { if (patch.period !== undefined) h.period = patch.period; } }) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useRef: (value: unknown) => { const i = h.cursor++; return h.slots[i] ??= { current: value }; },
  useCallback: (fn: unknown, deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as { fn: unknown; deps: readonly unknown[] } | undefined;
    if (!p || p.deps.length !== deps.length || !p.deps.every((v, j) => Object.is(v, deps[j]))) h.slots[i] = { fn, deps }; return (h.slots[i] as { fn: unknown }).fn; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as readonly unknown[] | undefined;
    if (p?.length === deps.length && p.every((v, j) => Object.is(v, deps[j]))) return; h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
function render(effects = true) { for (let i = 0; i < 12; i++) { h.cursor = 0; h.changed = false;
  const Inner = CountClient().props.children.type as () => ReactNode; const tree = Inner(); if (!effects) return tree;
  for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return tree; } throw Error("render did not settle"); }
const props = (type: string) => nodes(render()).find(n => n.type === type)!.props;
const fetchMock = vi.fn<typeof fetch>();
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); return render(); };
const row = (id: number) => ({ id, docNo: `PD-${id}`, status: "draft" });
const list = (id: number) => Response.json({ rows: [row(id)], total: 1, canCreate: true });
const detail = (id: number, version = 1) => ({ id, version, docNo: `PD-${id}`, status: "draft", actions: { edit: true, submit: true, approve: false, reason: null }, roleSummary: [], approvals: [], adjustDocs: [], lines: [
  { id: id * 10, skuId: 1, skuCode: "SKU-1", skuName: "精华液", batchId: 101, commercialRole: "sample", baseUom: "kg", bookQty: "0.1000", countedQty: "9999999999.9999", diffQty: "9999999999.8999" },
] });
const lineTable = () => nodes(props("drawer").children as ReactNode).find(n => n.type === "table" && n.props.rowKey === "id")!.props;
function qtyInput() { const table = lineTable(); const column = (table.columns as { dataIndex: string; render: (v: string, row: unknown) => Node }[]).find(c => c.dataIndex === "countedQty")!;
  const line = (table.dataSource as ReturnType<typeof detail>["lines"])[0]; return column.render(line.countedQty, line); }
const buttons = () => nodes(props("drawer").extra as ReactNode).filter(n => n.type === "button");
const save = () => buttons().find(n => JSON.stringify(n.props.children).includes("保存实盘数"))!;
const create = () => nodes(render()).find(n => n.type === "modal" && n.props.title === "新建盘点任务")!;
beforeEach(() => { h.cursor = 0; h.slots = []; h.effects = []; h.changed = false; h.q = ""; h.period = ""; h.detailId = null; vi.clearAllMocks(); fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("read-only draft hides editing and submit, explains authority and refuses stale callbacks", async () => {
  h.detailId=1;fetchMock.mockImplementation(async u=>String(u).endsWith('/1')?Response.json({...detail(1),actions:{edit:false,submit:false,approve:false,reason:'当前仅可查看，请由仓管录入'}}):Response.json({rows:[row(1)],total:1,canCreate:false}));render();await flush();
  expect(save()).toBeUndefined();expect(buttons().some(n=>n.props.children==='提交')).toBe(false);
  expect(nodes(props('drawer').children as ReactNode).some(n=>n.type==='scanner')).toBe(false);
  expect(JSON.stringify(props('drawer').children)).toContain('当前仅可查看');
  (create().props.onOk as()=>void)();await flush();expect(h.validate).not.toHaveBeenCalled();
});
it("pending action hints hide financial buttons without permission and retain them for qualified checker", async () => {
  h.detailId=1;let allowed=false;fetchMock.mockImplementation(async u=>String(u).endsWith('/1')?Response.json({...detail(1),status:'pending',actions:{edit:false,submit:false,approve:allowed,reason:allowed?null:'需要财务审批角色'}}):list(1));render();await flush();
  expect(buttons().some(n=>n.props.children==='审批通过')).toBe(false);
  allowed=true;(props('drawer').onRetry as()=>void)();render();await flush();
  expect(buttons().some(n=>n.props.children==='审批通过')).toBe(true);
});
it("missing action hints fail closed rather than exposing writes", async () => {
  h.detailId=1;fetchMock.mockImplementation(async u=>String(u).endsWith('/1')?Response.json({...detail(1),actions:undefined}):Response.json({rows:[row(1)],total:1}));render();await flush();
  expect(save()).toBeUndefined();expect(buttons().some(n=>n.props.children==='提交')).toBe(false);
});

it("list withdraws stale rows immediately and late results cannot change current query", async () => {
  const old = Promise.withResolvers<Response>();fetchMock.mockResolvedValueOnce(list(1)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(list(3));
  render();await flush();h.q = "OLD";expect(nodes(render(false)).find(n=>n.type==="table")!.props.dataSource).toEqual([]);render();h.q="NEW";render();await flush();old.resolve(list(2));await flush();expect(props("table").dataSource).toEqual([row(3)]);
});
it("list failure withdraws total; explicit retry reads without any POST", async () => {
  fetchMock.mockRejectedValueOnce(Error("offline"));render();await flush();expect(props("table").pagination).toBe(false);expect(props("read-error").error).toBeTruthy();
  fetchMock.mockResolvedValueOnce(list(2));(props("read-error").onRetry as () => void)();render();await flush();expect(props("table").dataSource).toEqual([row(2)]);expect(fetchMock.mock.calls.every(([,i])=>!i?.method)).toBe(true);
});
it("malformed list never becomes a successful empty list", async () => {fetchMock.mockResolvedValue(Response.json({rows:null,total:1}));render();await flush();expect(props("read-error").error).toContain("异常");expect(props("table").pagination).toBe(false);});
it("period restores from URL and clear removes it from actual request", async () => {
  h.period="2026-08";fetchMock.mockResolvedValue(list(1));render();await flush();const input=nodes(props("toolbar").extra as ReactNode).find(n=>n.props.placeholder==="盘点期 YYYY-MM")!;
  expect(input.key).toBe("2026-08");expect(input.props.defaultValue).toBe(h.period);expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("period=2026-08");
  (input.props.onChange as (e: unknown)=>void)({target:{value:""}});render();await flush();expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain("period=");
});
it("detail quantities stay decimal strings and each table has usable fixed columns", async () => {
  h.detailId=1;fetchMock.mockImplementation(async u=>String(u).endsWith('/1')?Response.json(detail(1)):list(1));render();await flush();
  expect(qtyInput().props).toMatchObject({stringMode:true,value:"9999999999.9999",min:"0"});
  expect(lineTable()).toMatchObject({tableLayout:"fixed",scroll:{x:1016}});
  const columns=lineTable().columns as {dataIndex:string;width?:number}[];expect(columns.find(c=>c.dataIndex==='skuName')!.width).toBeGreaterThanOrEqual(180);expect(columns.some(c=>c.dataIndex==='batchId')).toBe(true);
  expect(nodes(props("drawer").children as ReactNode).find(n=>n.type==='table'&&n.props.rowKey==='group')!.props).toMatchObject({tableLayout:'fixed',scroll:{x:650}});
});
it("save locks synchronous duplicate clicks, scanning, editing and drawer close; failure preserves entered value", async () => {
  h.detailId=1;const pending=Promise.withResolvers<Response>();fetchMock.mockImplementation(async(u,i)=>i?.method==='POST'?pending.promise:String(u).endsWith('/1')?Response.json(detail(1)):list(1));render();await flush();
  (qtyInput().props.onChange as (v:string)=>void)('0.2');render();const click=save().props.onClick as ()=>Promise<void>;const first=click();const second=click();render();
  expect(fetchMock.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);expect(qtyInput().props.disabled).toBe(true);expect(props('drawer')).toMatchObject({closable:false,keyboard:false,maskClosable:false});
  (props('drawer').onClose as ()=>void)();expect(h.setId).not.toHaveBeenCalled();const scanner=nodes(props('drawer').children as ReactNode).find(n=>n.type==='scanner')!;expect(scanner.props.disabled).toBe(true);expect((scanner.props.onScan as (...a:string[])=>boolean)('SKU-1','1')).toBe(false);
  pending.resolve(Response.json({error:'版本冲突，请核对'},{status:409}));await first;await second;await flush();expect(qtyInput().props.value).toBe('0.2');expect(JSON.stringify(props('drawer').children)).toContain('版本冲突');expect(save().props.disabled).toBe(false);
  expect(buttons().find(n=>n.props.children==='提交')!.props.disabled).toBe(true);
});
it("switching document withdraws old edits immediately and ignores late action feedback", async () => {
  h.detailId=1;const pending=Promise.withResolvers<Response>();fetchMock.mockImplementation(async(u,i)=>i?.method==='POST'?pending.promise:String(u).endsWith('/1')?Response.json(detail(1)):String(u).endsWith('/2')?Response.json(detail(2)):list(1));render();await flush();
  (qtyInput().props.onChange as(v:string)=>void)('0.2');render();const saving=(save().props.onClick as()=>Promise<void>)();render();h.detailId=2;render();await flush();expect(qtyInput().props.value).toBe('9999999999.9999');
  pending.resolve(Response.json({error:'旧单据拒绝'},{status:409}));await saving;await flush();expect(JSON.stringify(props('drawer').children)).not.toContain('旧单据拒绝');expect(h.message.success).not.toHaveBeenCalled();
});
it("invalid detail identity is not editable",async()=>{h.detailId=1;fetchMock.mockImplementation(async u=>String(u).endsWith('/1')?Response.json(detail(2)):list(1));render();await flush();expect(props('drawer').readError).toContain('身份');expect(props('drawer').extra).toBeNull();});
it("write timeout unlocks the form with an uncertain-result warning and never retries POST",async()=>{
  h.detailId=1;fetchMock.mockImplementation(async(u,i)=>i?.method==='POST'?new Promise((_resolve,reject)=>i.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))):String(u).endsWith('/1')?Response.json(detail(1)):list(1));render();await flush();
  (qtyInput().props.onChange as(v:string)=>void)('0.2');render();const saving=(save().props.onClick as()=>Promise<void>)();await vi.advanceTimersByTimeAsync(30_000);await saving;await flush();
  expect(props('drawer').closable).toBe(true);expect(qtyInput().props.value).toBe('0.2');expect(JSON.stringify(props('drawer').children)).toContain('操作可能已完成');expect(fetchMock.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
});
it("unsaved edits cannot be submitted through an already opened confirmation",async()=>{
  h.detailId=1;fetchMock.mockImplementation(async u=>String(u).endsWith('/1')?Response.json(detail(1)):list(1));render();await flush();
  (qtyInput().props.onChange as(v:string)=>void)('0.2');render();const confirmation=nodes(props('drawer').extra as ReactNode).find(n=>n.type==='confirm'&&n.props.okText==='提交')!;
  (confirmation.props.onConfirm as()=>void)();await flush();expect(fetchMock.mock.calls.every(([,i])=>!i?.method)).toBe(true);
});
it("creation locks before async form validation and cannot close while waiting",async()=>{
  fetchMock.mockResolvedValue(list(1));render();await flush();const validation=Promise.withResolvers<unknown>();h.validate.mockReturnValue(validation.promise);
  const click=create().props.onOk as()=>void;click();click();render();expect(h.validate).toHaveBeenCalledTimes(1);expect(create().props).toMatchObject({confirmLoading:true,closable:false,keyboard:false});
  expect(nodes(create()).find(n=>n.props.layout==='vertical')!.props.disabled).toBe(true);validation.reject({errorFields:[{}]});await flush();expect(create().props.confirmLoading).toBe(false);expect(fetchMock.mock.calls.every(([,i])=>!i?.method)).toBe(true);
});
