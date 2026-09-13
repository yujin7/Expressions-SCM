import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CtClient from "@/app/(app)/matflow/ct/ct-client";
import CtDraftVoid from "@/app/(app)/matflow/ct/ct-draft-void";
import CtCreateRecovery, { useCtCreateRecovery } from "@/components/CtCreateRecovery";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false,
  q: "", detailId: null as number | null, actorId: 1, roles: ["warehouse"], rootKey: null as string | null, approver: false, message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: h.message }) }, Alert: "alert", Button: "button", Modal: "modal", Space: "space", Table: "table", Tabs: "tabs", Popconfirm: "confirm", Select: "select", InputNumber: "number",
  Input: Object.assign("input", { TextArea: "textarea" }), Descriptions: Object.assign("descriptions", { Item: "item" }), Typography: { Title: "title", Paragraph: "paragraph", Link: "a" } }));
vi.mock("@ant-design/icons", () => ({ PlusOutlined: "plus", ReloadOutlined: "reload" }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "read-error" }));
vi.mock("@/components/DocumentDrawer", () => ({ default: "drawer" }));
vi.mock("@/components/ChainStrip", () => ({ default: "chain" }));
vi.mock("@/components/DocStatusTag", () => ({ default: "status" }));
vi.mock("@/components/ApprovalTimeline", () => ({ default: "timeline" }));
vi.mock("@/components/useMe", () => ({ useMe: () => ({ id: h.actorId, roles: h.roles, isApprover: h.approver }), hasAnyRole: () => true }));
vi.mock("@/components/useDocumentTarget", () => ({ useDocumentTarget: () => ({ id: h.detailId, setId: vi.fn(), present: h.detailId != null }) }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { q: h.q, status: "" }, page: 1, pageSize: 20, tableSize: "small", paginationProps: (v: unknown) => v }) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: <T,>(initial: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useCallback: (fn: unknown, deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as { fn: unknown; deps: readonly unknown[] } | undefined;
    if (!p || p.deps.length !== deps.length || !p.deps.every((v, j) => Object.is(v, deps[j]))) h.slots[i] = { fn, deps }; return (h.slots[i] as { fn: unknown }).fn; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as readonly unknown[] | undefined;
    if (p?.length === deps.length && p.every((v, j) => Object.is(v, deps[j]))) return; h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
// Execute the keyed workspace boundary explicitly; the harness does not mount arbitrary React children.
function render(effects = true) { for (let i = 0; i < 12; i++) { h.cursor = 0; h.changed = false; const root = CtClient();
  if (h.rootKey !== root.key) { for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); h.slots = []; h.effects = []; h.rootKey = root.key; }
  const tree = (root.type as (props: unknown) => ReactNode)(root.props); if (!effects) return tree;
  for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return tree; } throw Error("render did not settle"); }
const props = (type: string) => nodes(render()).find(n => n.type === type)!.props;
const fetchMock = vi.fn<typeof fetch>();
const storage = new Map<string, string>();
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); return render(); };
const list = (id: number) => Response.json({ rows: [{ id, docNo: `CT-${id}`, status: "draft" }], total: 1 });
const po = (id: number) => Response.json({ id, lines: [{ id, skuId: id, skuCode: `SKU-${id}`, skuName: "合成物料", baseUom: "kg", receivedQty: "2" }] });
const create = () => nodes(render()).find(n => n.type === "modal" && n.props.title === "新建采购退货单")!;
const lines = () => nodes(create()).find(n => n.type === "table")!.props;
const recoveryNode = () => nodes(render()).find(n => n.type === CtCreateRecovery)!;
const recovery = () => recoveryNode().props.recovery as ReturnType<typeof useCtCreateRecovery>;
function open() { const button = nodes(props("toolbar").primaryActions as ReactNode).find(n => n.props.children === "新建退货单")!; (button.props.onClick as () => void)(); render(); }
function select(id: number) { const p = nodes(create()).find(n => n.props.placeholder === "选择采购订单")!.props; (p.onChange as (v: number) => void)(id); render(); }
beforeEach(() => { h.cursor = 0; h.slots = []; h.effects = []; h.changed = false; h.q = ""; h.detailId = null; h.actorId = 1; h.roles = ["warehouse"]; h.rootKey = null; h.approver = false; vi.clearAllMocks(); fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock);
  storage.clear(); vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("navigator", { locks: { request: (_key: string, action: () => Promise<unknown>) => action() } });
});
afterEach(() => { for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("list query changes withdraw old rows before effects, and reject late responses", async () => {
  const old = Promise.withResolvers<Response>(); fetchMock.mockResolvedValueOnce(list(1)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(list(3));
  render(); await flush(); h.q = "OLD"; expect(nodes(render(false)).find(n => n.type === "table")!.props.dataSource).toEqual([]); render();
  h.q = "NEW"; render(); await flush(); old.resolve(list(2)); await flush(); expect(props("table").dataSource).toMatchObject([{ id: 3 }]);
});
it("list failure is persistent, withdraws totals, and retries the current query", async () => {
  fetchMock.mockRejectedValueOnce(Error("offline")); render(); await flush();
  expect(props("table").pagination).toBe(false); const error = nodes(render()).find(n => n.type === "read-error" && n.props.subject === "采购退货列表")!;
  expect(error?.props.error).toBeTruthy(); fetchMock.mockResolvedValueOnce(list(2)); (error.props.onRetry as () => void)(); render(); await flush(); expect(props("table").dataSource).toMatchObject([{ id: 2 }]);
});
it("old selected PO cannot overwrite current return lines or submit them", async () => {
  const old = Promise.withResolvers<Response>();
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? old.promise : String(url).endsWith("/2") ? po(2) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(); select(1); select(2); await flush(); old.resolve(po(1)); await flush();
  expect(lines().dataSource).toMatchObject([{ poLineId: 2, skuId: 2 }]);
});
it("PO detail timeout is explicit and retry never restores a late old selection", async () => {
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? new Promise(() => {}) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(); select(1); await vi.advanceTimersByTimeAsync(15_000); await flush();
  const error = nodes(create()).find(n => n.type === "read-error")!; expect(error?.props.error).toContain("超时");
  expect(create().props.okButtonProps).toMatchObject({ disabled: true });
  fetchMock.mockResolvedValueOnce(po(1)); (error.props.onRetry as () => void)(); render(); await flush(); expect(lines().dataSource).toMatchObject([{ poLineId: 1 }]);
});
it("closing and reopening cannot revive previous PO facts; malformed identity blocks create", async () => {
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? po(2) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(); select(1); await flush(); expect(lines().dataSource).toEqual([]);
  expect(create().props.okButtonProps).toMatchObject({ disabled: true });
  (create().props.onCancel as () => void)(); render(); open(); expect(lines().dataSource).toEqual([]);
});
it("create uses an independently scrollable fixed-width table", () => {
  fetchMock.mockReturnValue(new Promise(() => {})); render(); open();
  expect(lines().scroll).toEqual({ x: 1140, y: 320 }); expect(lines().tableLayout).toBe("fixed");
  const material = (lines().columns as { width?: number }[])[0]; expect(material.width).toBe(220);
});

type CreateRow = { rowKey: string; index: number; poLineId: number; skuId: number; qty: string; batchId?: number | null; reason: string };
function cell(key: string, index = 0) {
  const table = lines();
  const row = (table.dataSource as CreateRow[])[index];
  const column = (table.columns as { key?: string; render?: (value: unknown, row: CreateRow) => ReactNode }[]).find(c => c.key === key)!;
  return nodes(column.render!(null, row))[0].props;
}
async function prepared() {
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? po(1) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(); select(1); await flush();
  (nodes(create()).find(n => n.props.placeholder === "选择退货出库仓")!.props.onChange as (v: number) => void)(10); render();
}
it("warehouse clear removes physical lots and quantities, disabling creation", async () => {
  await prepared();
  for (const placeholder of ["选择采购订单", "选择退货出库仓"]) expect(nodes(create()).find(n => n.props.placeholder === placeholder)!.props.allowClear).toBe(true);
  expect(cell("batch").allowClear).toBe(true);
  (cell("batch").onChange as (v: number) => void)(3); render(); (cell("qty").onChange as (v: string) => void)("1.1234"); render();
  (nodes(create()).find(n => n.props.placeholder === "选择退货出库仓")!.props.onChange as (v: undefined) => void)(undefined); render();
  expect(lines().dataSource).toMatchObject([{ qty: "0", batchId: undefined }]);
  expect(cell("batch").disabled).toBe(true); expect(create().props.okButtonProps).toMatchObject({ disabled: true });
});
it.each([true, false, undefined])("pending approval controls follow the server qualification (%s), not the local role", async allowed => {
  h.detailId = 1; h.approver = true;
  fetchMock.mockImplementation(async url => String(url).endsWith("/ct/1") ? Response.json({ id: 1, createdBy: 2, docNo: "CT-1", status: "pending", lines: [], approvals: [],
    actions: allowed === undefined ? undefined : { approve: allowed, reject: allowed, edit: false, submit: false, reason: "当前服务端资格" } }) : Response.json({ rows: [], total: 0 }));
  render(); await flush();
  const buttons = nodes(props("drawer").extra as ReactNode).filter(n => n.type === "button").map(n => n.props.children);
  expect(buttons.includes("审批通过")).toBe(allowed === true);
  expect(buttons.includes("驳回")).toBe(allowed === true);
});
it("a quantity block disables approval while keeping independent rejection available", async () => {
  h.detailId = 1;
  fetchMock.mockImplementation(async url => String(url).endsWith("/ct/1") ? Response.json({ id: 1, createdBy: 2, docNo: "CT-1", status: "pending", lines: [], approvals: [],
    actions: { approve: false, reject: true, edit: false, submit: false, reason: "退货量超过已收数；仍可驳回" } }) : Response.json({ rows: [], total: 0 }));
  render(); await flush();
  const buttons = nodes(props("drawer").extra as ReactNode).filter(n => n.type === "button");
  expect(buttons.find(n => n.props.children === "审批通过")?.props.disabled).toBe(true);
  expect(buttons.some(n => n.props.children === "驳回")).toBe(true);
});
it.each([true, false, undefined])("void entry follows the service hint (%s), including an invalid source", async allowed => {
  h.detailId = 1;
  fetchMock.mockImplementation(async url => String(url).endsWith("/ct/1") ? Response.json({ id: 1, version: 3, createdBy: 1, docNo: "CT-1", status: "draft", lines: [], approvals: [],
    actions: { void: allowed, edit: false, submit: false, reason: "来源已关闭" } }) : Response.json({ rows: [], total: 0 }));
  render(); await flush();
  const button = nodes(props("drawer").extra as ReactNode).find(n => n.props.children === "作废错误草稿");
  expect(!!button).toBe(allowed === true);
  if (button) {
    (button.props.onClick as () => void)();
    const dialog = nodes(render()).find(n => n.type === CtDraftVoid)!;
    expect(dialog.props.doc).toMatchObject({ id: 1, version: 3 });
    (dialog.props.onReload as () => void)(); render(); await flush();
    expect(nodes(render()).some(n => n.type === CtDraftVoid)).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  }
});
it("voided detail retains reason and opens a blank replacement only on explicit click", async () => {
  h.detailId = 1;
  fetchMock.mockImplementation(async url => String(url).endsWith("/ct/1") ? Response.json({ id: 1, createdBy: 1, docNo: "CT-1", status: "void", closedReason: "实物批次选错", lines: [], approvals: [],
    actions: { void: false, edit: false, submit: false, reason: "已结束" } }) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); expect(create().props.open).toBe(false);
  expect(nodes(render()).some(n => n.props.message === "作废原因：实物批次选错")).toBe(true);
  const button = nodes(props("drawer").extra as ReactNode).find(n => n.props.children === "新建正确退货单")!;
  (button.props.onClick as () => void)(); render();
  expect(create().props.open).toBe(true); expect(lines().dataSource).toEqual([]);
  expect(create().props.okButtonProps).toMatchObject({ disabled: true });
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
it.each(["identity", "roles"])("%s change remounts the workspace and clears another actor's open form", async change => {
  await prepared(); expect(create().props.open).toBe(true);
  if (change === "identity") h.actorId = 2; else h.roles = ["ops"];
  render(); expect(create().props.open).toBe(false); expect(lines().dataSource).toEqual([]);
});
it("split batches preserve PO line identity and reject combined over-return before POST", async () => {
  await prepared(); (cell("batch").onChange as (v: number) => void)(3); render(); (cell("qty").onChange as (v: string) => void)("1.5"); render();
  (cell("split").onClick as () => void)(); render(); (cell("batch", 1).onChange as (v: string) => void)("unbatched"); render(); (cell("qty", 1).onChange as (v: string) => void)("1"); render();
  expect(lines().dataSource).toMatchObject([{ rowKey: "1:0", poLineId: 1, batchId: 3 }, { rowKey: "1:1", poLineId: 1, batchId: null }]);
  await (create().props.onOk as () => Promise<void>)(); await flush();
  expect(h.message.warning).toHaveBeenCalledWith(expect.stringContaining("合计超过"));
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
it("missing physical selection and over-precision cannot silently become a partial draft", async () => {
  await prepared(); (cell("qty").onChange as (v: string) => void)("1"); render();
  await (create().props.onOk as () => Promise<void>)(); expect(h.message.warning).toHaveBeenLastCalledWith(expect.stringContaining("实际退货批次"));
  (cell("qty").onChange as (v: string) => void)("0.00001"); render();
  await (create().props.onOk as () => Promise<void>)(); expect(h.message.warning).toHaveBeenLastCalledWith(expect.stringContaining("4位小数"));
});
it("synchronous repeated create submits once and preserves explicit batch/null payload", async () => {
  await prepared(); (cell("batch").onChange as (v: string) => void)("unbatched"); render(); (cell("qty").onChange as (v: string) => void)("1"); render();
  const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValue(pending.promise);
  const submit = create().props.onOk as () => void; submit(); submit();
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(writes).toHaveLength(1); expect(JSON.parse(String(writes[0][1]?.body)).lines).toEqual([{ poLineId: 1, skuId: 1, qty: "1", batchId: null }]);
  pending.resolve(Response.json({ id: 4 })); await flush();
});

it("a malformed list is an error, not a successful empty or unsafe row set", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ rows: [null], total: 1 })); render(); await flush();
  expect(props("table").dataSource).toEqual([]); expect(props("table").pagination).toBe(false);
  expect(nodes(render()).find(n => n.type === "read-error" && n.props.subject === "采购退货列表")?.props.error).toContain("格式异常");
});
it("failed PO reads keep creation disabled and retries issue only GET, never a duplicate draft", async () => {
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? Response.json({ error: "合成读取失败" }, { status: 503 }) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(); select(1); await flush();
  await (create().props.onOk as () => Promise<void>)(); await flush();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  fetchMock.mockResolvedValueOnce(po(1));
  (nodes(create()).find(n => n.type === "read-error")!.props.onRetry as () => void)(); render(); await flush();
  expect(lines().dataSource).toMatchObject([{ qty: "0", poLineId: 1 }]);
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("lost create response survives workspace remount; lookup/acknowledgement never resend or erase early", async () => {
  await prepared(); (cell("batch").onChange as (v: string) => void)("unbatched"); render(); (cell("qty").onChange as (v: string) => void)("1"); render();
  fetchMock.mockRejectedValueOnce(Error("reply lost")); await (create().props.onOk as () => Promise<void>)(); await flush();
  const original = recovery().request!; expect(original.requestKey).toBeTruthy(); expect(storage.size).toBe(1);
  h.rootKey = null; render(); await flush(); expect(recovery().request).toEqual(original);
  const count = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").length;
  expect(count).toBe(1); expect(recovery().result).toBeNull();
  const found = { requestKey: original.requestKey, document: { id: 90, docNo: "CT-20260914-0090", status: "void" } };
  fetchMock.mockImplementation(async url => String(url).includes("create-result") ? Response.json(found) : Response.json({ rows: [], total: 0 }));
  await recovery().lookup(); await flush(); expect(recovery().result).toEqual(found); expect(storage.size).toBe(1);
  await recovery().acknowledge(); await flush(); expect(storage.size).toBe(0); expect(recovery().request).toBeNull();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
it("restored missing/changed source identity blocks correction instead of silently dropping a physical line", async () => {
  await prepared();
  const request = { requestKey: "ee392149-8738-4e50-992f-f565bba7f911", poId: 1, warehouseId: 10,
    lines: [{ poLineId: 1, skuId: 999, qty: "1", batchId: null }] };
  (recoveryNode().props.onEdit as (request: unknown) => void)(request); render(); await flush();
  expect(create().props.okButtonProps).toMatchObject({ disabled: true });
  expect(nodes(create()).some(n => typeof n.props.message === "string" && n.props.message.includes("物料身份已变"))).toBe(true);
  await (create().props.onOk as () => Promise<void>)(); expect(h.message.warning).toHaveBeenCalledWith(expect.stringContaining("身份变化"));
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
it("late creation after account change cannot report success or navigate as the new actor", async () => {
  await prepared(); (cell("batch").onChange as (v: string) => void)("unbatched"); render(); (cell("qty").onChange as (v: string) => void)("1"); render();
  const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
  const save = (create().props.onOk as () => Promise<void>)(); render();
  const key = recovery().request!.requestKey; h.actorId = 2; render(); await flush();
  const receipt = { requestKey: key, document: { id: 90, docNo: "CT-20260914-0090", status: "draft" } };
  fetchMock.mockResolvedValue(Response.json(receipt)); pending.resolve(Response.json(receipt)); await save; await flush();
  expect(h.message.success).not.toHaveBeenCalled(); expect(recovery().request).toBeNull(); expect(storage.size).toBe(1);
});
