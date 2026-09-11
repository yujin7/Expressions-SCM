import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BatchTraceClient from "@/app/(app)/inventory/batch-trace/batch-trace-client";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false,
  allowed: true, message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  form: { resetFields: vi.fn(), setFieldsValue: vi.fn(), validateFields: vi.fn() } }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: h.message }) }, Alert: "alert", Card: "card", Empty: "empty", Tag: "tag", Button: "button", Modal: "modal", Space: "space", Table: "table", Select: "select", InputNumber: "number",
  Form: Object.assign("form", { Item: "form-item", useForm: () => [h.form] }),
  Input: Object.assign("input", { TextArea: "textarea" }), Descriptions: Object.assign("descriptions", { Item: "item" }), Typography: { Title: "title", Text: "text" } }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "read-error" }));
vi.mock("@/components/useMe", () => ({ useMe: () => ({ id: 1, roles: ["warehouse"] }), hasAnyRole: () => h.allowed }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useRef: <T,>(value: T) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: value }; return h.slots[i]; },
  useCallback: (fn: unknown, deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as { fn: unknown; deps: readonly unknown[] } | undefined;
    if (!p || p.deps.length !== deps.length || !p.deps.every((v, j) => Object.is(v, deps[j]))) h.slots[i] = { fn, deps }; return (h.slots[i] as { fn: unknown }).fn; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as readonly unknown[] | undefined;
    if (p?.length === deps.length && p.every((v, j) => Object.is(v, deps[j]))) return; h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
function render(effects = true) { for (let i = 0; i < 12; i++) { h.cursor = 0; h.changed = false; const tree = BatchTraceClient(); if (!effects) return tree;
  for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return tree; } throw Error("render did not settle"); }
const props = (type: string) => nodes(render()).find(n => n.type === type)!.props;
const fetchMock = vi.fn<typeof fetch>();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); return render(); };
const trace = (id: number, page = 1, pageSize = 30) => ({ batch: { id, skuId: id * 10, skuCode: `SKU-${id}`, batchNo: `LOT-${id}`, skuName: "合成物料", baseUom: "瓶", prodDate: null, expiryDate: null }, source: { docType: "sh", docId: id, href: `/matflow/sh?docId=${id}` }, ledger: [], ledgerPage: { page, pageSize, total: 0 }, stockByWarehouse: [], coverage: { outboundTraceable: false, note: "部分覆盖" } });
const placement = (id: number) => ({ rows: [{ key: `unlocated:${id}`, warehouseId: id, warehouseName: `仓${id}`, binId: null, binCode: null, binName: null, binKind: null, qty: "1.0001", locationState: "unlocated" }], bins: [{ id: id + 100, warehouseId: id, code: "Q", name: "隔离", kind: "quarantine" }] });
function change(label: string, value: string) { (nodes(render()).find(n => n.props["aria-label"] === label)!.props.onChange as (e: unknown) => void)({ target: { value } }); }
function run(id: number) { change("SKU 编码", `SKU-${id}`); render(); change("批次号", `LOT-${id}`); render(); (nodes(render()).find(n => n.type === "button" && n.props.children === "追溯")!.props.onClick as () => void)(); render(); }
const placements = () => nodes(render()).find(n => n.type === "table" && n.props.rowKey === "key")?.props;
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
function open() { const table = placements()!; const column = (table.columns as { key?: string; render: (v: unknown, row: unknown) => Node }[]).find(c => c.key === "_actions")!;
  (column.render(null, (table.dataSource as unknown[])[0]).props.onClick as () => void)(); render(); }
async function ready(id = 1) { run(id); await flush(); await flush(); }
beforeEach(() => { h.cursor = 0; h.slots = []; h.effects = []; h.changed = false; h.allowed = true; vi.clearAllMocks(); fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock);
  h.form.validateFields.mockResolvedValue({ qty: "0.0001", reason: "合成隔离验证", toBinId: 101 });
  fetchMock.mockImplementation(async url => { const u = new URL(String(url), "http://localhost"); const id = Number((u.searchParams.get("sku") ?? "").split("-")[1] ?? u.searchParams.get("batchId"));
    return Response.json(u.pathname.endsWith("batch-trace") ? trace(id, Number(u.searchParams.get("page") ?? 1), Number(u.searchParams.get("pageSize") ?? 30)) : placement(Number(u.searchParams.get("batchId")))); }); });
afterEach(() => { for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("editing the lookup withdraws old facts and its modal before effect cleanup", async () => {
  await ready(); open(); expect(props("modal").open).toBe(true);
  change("SKU 编码", "SKU-2"); const tree = nodes(render(false));
  expect(tree.some(n => n.type === "card")).toBe(false); expect(tree.find(n => n.type === "modal")!.props.open).toBe(false);
});
it("late trace and placement responses cannot replace a newer query", async () => {
  const late = Promise.withResolvers<Response>(); const oldBins = Promise.withResolvers<Response>();
  fetchMock.mockImplementation(async url => { const u = String(url);
    if (u.includes("sku=SKU-1")) return late.promise;
    if (u.includes("batchId=2")) return oldBins.promise;
    return Response.json(u.includes("batch-trace") ? trace(u.includes("SKU-2") ? 2 : 3) : placement(3)); });
  run(1); run(2); await flush(); run(3); await flush(); await flush();
  late.resolve(Response.json(trace(1))); oldBins.resolve(Response.json(placement(2))); await flush();
  expect(placements()!.dataSource).toMatchObject([{ warehouseId: 3 }]); expect(JSON.stringify(render())).not.toContain("LOT-1");
});
it("refreshing the same batch withdraws its previous placement actions", async () => {
  await ready(); open(); run(1); expect(props("modal").open).toBe(false); expect(placements()).toBeUndefined();
  await flush(); await flush(); expect(placements()!.dataSource).toMatchObject([{ warehouseId: 1 }]);
});
it("placement failure is not zero stock and explicit retry only reads", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(trace(1))).mockRejectedValueOnce(Error("offline"));
  await ready(); expect(placements()!.locale).toMatchObject({ emptyText: "库位分布尚未加载，不能判断可作业库存" });
  const error = nodes(render()).find(n => n.type === "read-error" && n.props.subject === "库位分布")!; expect(error.props.error).toBeTruthy();
  (error.props.onRetry as () => void)(); render(); await flush(); expect(placements()!.dataSource).toHaveLength(1); expect(posts()).toHaveLength(0);
});
it.each(["wrong-sku", "wrong-batch", "missing-array"])("%s response never enables placements", async kind => {
  const data = trace(1); if (kind === "wrong-sku") data.batch.skuCode = "SKU-2";
  if (kind === "wrong-batch") data.batch.batchNo = "LOT-2"; if (kind === "missing-array") Object.assign(data, { ledger: null });
  fetchMock.mockResolvedValue(Response.json(data)); await ready(); expect(placements()).toBeUndefined();
  expect(nodes(render()).find(n => n.type === "read-error")!.props.error).toContain("不匹配"); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("late saved action callback cannot submit another batch's inventory", async () => {
  await ready(); open(); const onOk = props("modal").onOk as () => void; await ready(2); onOk(); await flush();
  expect(posts()).toHaveLength(0);
});
it("double confirmation sends one decimal-string mutation bound to the displayed target", async () => {
  await ready(); open(); expect(h.form.setFieldsValue).toHaveBeenLastCalledWith({ qty: "1.0001", reason: "", toBinId: undefined });
  const saving = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(saving.promise);
  const onOk = props("modal").onOk as () => void; onOk(); onOk(); await flush();
  expect(posts()).toHaveLength(1); expect(JSON.parse(String(posts()[0][1]!.body))).toMatchObject({ skuId: 10, batchId: 1, warehouseId: 1, fromBinId: null, toBinId: 101, qty: "0.0001", intent: "quarantine" });
  expect(props("modal").cancelButtonProps).toEqual({ disabled: true }); change("SKU 编码", "WRONG"); (props("modal").onCancel as () => void)(); render();
  expect(props("modal").open).toBe(true); expect(nodes(render()).find(n => n.props["aria-label"] === "SKU 编码")!.props.value).toBe("SKU-1");
  saving.resolve(Response.json({ id: 1 })); await flush(); await flush(); expect(props("modal").open).toBe(false);
});
it("role withdrawal during asynchronous validation prevents the write", async () => {
  await ready(); open(); const validation = Promise.withResolvers<unknown>(); h.form.validateFields.mockReturnValueOnce(validation.promise);
  (props("modal").onOk as () => void)(); h.allowed = false; render(); validation.resolve({ qty: "1", reason: "test" }); await flush(); expect(posts()).toHaveLength(0);
});
it("uncertain write exposes a persistent read-only recovery, not automatic replay", async () => {
  await ready(); open(); fetchMock.mockRejectedValueOnce(Error("lost response")); (props("modal").onOk as () => void)(); await flush();
  const error = nodes(render()).find(n => n.type === "alert" && n.props.message === "操作未确认，请先核对结果")!;
  expect(error.props.description).toContain("勿重复提交"); expect(props("modal").okButtonProps).toEqual({ disabled: true });
  (nodes(error.props.action as ReactNode)[0].props.onClick as () => void)(); render(); await flush(); expect(posts()).toHaveLength(1); expect(props("modal").open).toBe(false);
});
it("trace timeout is visible and never triggers a placement read", async () => {
  fetchMock.mockReturnValue(new Promise(() => {})); run(1); await vi.advanceTimersByTimeAsync(15_000); await flush();
  expect(nodes(render()).find(n => n.type === "read-error")!.props.error).toContain("超时"); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("write timeout warns that abort is not cancellation and blocks resubmission", async () => {
  await ready(); open(); fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  (props("modal").onOk as () => void)(); await flush(); await vi.advanceTimersByTimeAsync(30_000); await flush();
  expect(nodes(render()).find(n => n.type === "alert" && n.props.message === "操作未确认，请先核对结果")!.props.description).toContain("服务端可能已完成");
  (props("modal").onOk as () => void)(); await flush(); expect(posts()).toHaveLength(1);
});
it("lookup has exactly two labelled fields and the placement table scrolls internally", async () => {
  await ready(); expect(nodes(render()).filter(n => String(n.type) === "input").map(n => n.props["aria-label"])).toEqual(["SKU 编码", "批次号"]); expect(placements()!.scroll).toEqual({ x: 660 });
  expect(nodes(render()).filter(n => n.type === "table").map(n => n.props.scroll)).toEqual([{ x: 420 }, { x: 660 }, { x: 830 }]);
  expect(nodes(render()).find(n => String(n.type) === "descriptions")!.props.column).toEqual({ xs: 1, sm: 2 });
});
it("Chinese composition confirmation does not submit an unfinished lookup", () => {
  change("SKU 编码", "SKU-1"); render(); change("批次号", "LOT-1"); render();
  const enter = nodes(render()).find(n => n.props["aria-label"] === "批次号")!.props.onPressEnter as (e: unknown) => void;
  enter({ nativeEvent: { isComposing: true }, keyCode: 13 }); enter({ nativeEvent: { isComposing: false }, keyCode: 229 }); render(); expect(fetchMock).not.toHaveBeenCalled();
  enter({ nativeEvent: { isComposing: false }, keyCode: 13 }); render(); expect(fetchMock).toHaveBeenCalledTimes(1);
});

const ledgerTable = () => nodes(render()).find(n => n.type === "table" && n.props.rowKey === "id")!.props;
const pageTo = (page: number, size = 30) => (ledgerTable().pagination as { onChange: (p: number, s: number) => void }).onChange(page, size);
it("paging binds the response to its page and closes old placement actions immediately", async () => {
  await ready(); open(); const late = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(late.promise);
  pageTo(2); expect(nodes(render(false)).some(n => n.type === "card")).toBe(false); render();
  expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("page=2&pageSize=30");
  late.resolve(Response.json(trace(1, 2))); await flush(); await flush();
  expect(ledgerTable().pagination).toMatchObject({ current: 2, pageSize: 30 }); expect(props("modal").open).toBe(false);
  pageTo(2, 50); render(); await flush(); await flush(); expect(ledgerTable().pagination).toMatchObject({ current: 1, pageSize: 50 });
});
it("a response for the wrong page cannot display old ledger facts", async () => {
  await ready(); fetchMock.mockResolvedValueOnce(Response.json(trace(1, 1))); pageTo(2); render(); await flush();
  expect(placements()).toBeUndefined(); expect(nodes(render()).find(n => n.type === "read-error")!.props.error).toContain("不匹配");
});
it("paging is blocked during an uncertain in-flight inventory operation", async () => {
  await ready(); open(); const saving = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(saving.promise);
  (props("modal").onOk as () => void)(); await flush(); pageTo(2); render();
  expect(ledgerTable().pagination).toMatchObject({ current: 1, disabled: true });
  saving.resolve(Response.json({ id: 1 })); await flush();
});
it("duplicate immutable ledger IDs are a visible response error, not merged table rows", async () => {
  const row = { id: 4, qtyDelta: "0.0001", occurredAt: "2026-09-04", warehouse: "仓1", sourceDocType: "opening", sourceDocId: 1, sourceLineId: 1, sourceDocNo: null, sourceHref: null };
  fetchMock.mockResolvedValueOnce(Response.json({ ...trace(1), ledger: [row, row], ledgerPage: { page: 1, pageSize: 30, total: 2 } }));
  await ready(); expect(placements()).toBeUndefined(); expect(nodes(render()).find(n => n.type === "read-error")!.props.error).toContain("不匹配");
});
it("source links have continuous click targets and decimal quantities are not rounded", async () => {
  const row = { id: 4, qtyDelta: "-0.0001", occurredAt: "2026-09-04", warehouse: "仓1", sourceDocType: "sales_out", sourceDocId: 41, sourceLineId: 5, sourceDocNo: "CK-QA-41", sourceHref: "/inventory/docs?docId=41" };
  fetchMock.mockResolvedValueOnce(Response.json({ ...trace(1), ledger: [row], ledgerPage: { page: 1, pageSize: 30, total: 1 } }));
  await ready(); const cols = ledgerTable().columns as { title: string; render?: (v: unknown, row: unknown) => Node | string }[];
  expect(cols.find(c => c.title === "数量（瓶）")!.render!(row.qtyDelta, row)).toBe("0.0001");
  const link = cols.find(c => c.title === "来源单据")!.render!(null, row) as Node;
  expect(link.props).toMatchObject({ href: "/inventory/docs?docId=41", style: { display: "inline-block" }, children: "CK-QA-41" });
});
