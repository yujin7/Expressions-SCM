import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ShClient from "@/app/(app)/matflow/sh/sh-client";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false,
  q: "", from: "", to: "", detailId: null as number | null, message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: h.message }) }, Alert: "alert", Badge: "badge", Tag: "tag", Button: "button", Modal: "modal", Space: "space", Table: "table", Tabs: "tabs", Popconfirm: "confirm", Select: "select", InputNumber: "number", DatePicker: "date", Radio: { Group: "radio" },
  Input: Object.assign("input", { TextArea: "textarea" }), Descriptions: Object.assign("descriptions", { Item: "item" }), Typography: { Title: "title", Paragraph: "paragraph", Link: "a", Text: "text" } }));
vi.mock("@ant-design/icons", () => ({ PlusOutlined: "plus", ReloadOutlined: "reload", DeleteOutlined: "delete" }));
vi.mock("@/components/ListToolbar", () => ({ default: "toolbar" }));
vi.mock("@/components/SearchInput", () => ({ default: "search" }));
vi.mock("@/components/RemoteSelect", () => ({ default: "remote" }));
vi.mock("@/components/LoadErrorAlert", () => ({ default: "read-error" }));
vi.mock("@/components/DocumentDrawer", () => ({ default: "drawer" }));
vi.mock("@/components/ChainStrip", () => ({ default: "chain" }));
vi.mock("@/components/DocStatusTag", () => ({ default: "status" }));
vi.mock("@/components/ApprovalTimeline", () => ({ default: "timeline" }));
vi.mock("@/components/ScannerEntry", () => ({ default: "scanner" }));
vi.mock("@/components/useMe", () => ({ useMe: () => ({ id: 1, roles: ["warehouse"], isApprover: true }), hasAnyRole: () => true }));
vi.mock("@/components/useDocumentTarget", () => ({ useDocumentTarget: () => ({ id: h.detailId, setId: vi.fn(), present: h.detailId !== null }) }));
vi.mock("@/components/useListState", () => ({ useListState: () => ({ filters: { q: h.q, status: "", from: h.from, to: h.to }, page: 1, pageSize: 20, tableSize: "small", paginationProps: (v: unknown) => v,
  setFilter: (patch: { from?: string; to?: string }) => { if (patch.from !== undefined) h.from = patch.from; if (patch.to !== undefined) h.to = patch.to; } }) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useCallback: (fn: unknown, deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as { fn: unknown; deps: readonly unknown[] } | undefined;
    if (!p || p.deps.length !== deps.length || !p.deps.every((v, j) => Object.is(v, deps[j]))) h.slots[i] = { fn, deps }; return (h.slots[i] as { fn: unknown }).fn; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as readonly unknown[] | undefined;
    if (p?.length === deps.length && p.every((v, j) => Object.is(v, deps[j]))) return; h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
function render(effects = true) { for (let i = 0; i < 12; i++) { h.cursor = 0; h.changed = false; const tree = ShClient(); if (!effects) return tree;
  for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return tree; } throw Error("render did not settle"); }
const props = (type: string) => nodes(render()).find(n => n.type === type)!.props;
const fetchMock = vi.fn<typeof fetch>();
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); return render(); };
const list = (id: number) => Response.json({ rows: [{ id, docNo: `SH-${id}`, status: "draft" }], total: 1 });
const po = (id: number) => Response.json({ id, status: "approved", lines: [1, 2].map(n => ({ id: id * 10 + n, skuId: id, skuCode: `SKU-${id}`, skuName: "合成物料", barcode: null, baseUom: "kg", purchaseUom: "kg", qty: "10", receivedQty: "2" })) });
const jg = (id: number) => Response.json({ id, status: "approved", productSkuId: id, productSkuCode: `SKU-${id}`, productSkuName: "合成成品", productSkuBarcode: null, qty: "10" });
const create = () => nodes(render()).find(n => n.type === "modal" && n.props.title === "新建收货单")!;
const lines = () => nodes(create()).find(n => n.type === "table")?.props;
function open(kind = "po") { const button = nodes(props("toolbar").primaryActions as ReactNode).find(n => n.props.children === "新建收货单")!; (button.props.onClick as () => void)(); render();
  (nodes(create()).find(n => n.type === "radio")!.props.onChange as (e: unknown) => void)({ target: { value: kind } }); render(); }
function select(id: number) { const p = nodes(create()).find(n => n.props.placeholder === "选择来源单据")!.props; (p.onChange as (v: number) => void)(id); render(); }
beforeEach(() => { h.cursor = 0; h.slots = []; h.effects = []; h.changed = false; h.q = ""; h.from = ""; h.to = ""; h.detailId = null; vi.clearAllMocks(); fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { for (const fn of h.cleanups.values()) fn(); h.cleanups.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("list withdraws obsolete rows before effects and ignores a late result", async () => {
  const old = Promise.withResolvers<Response>(); fetchMock.mockResolvedValueOnce(list(1)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(list(3));
  render(); await flush(); h.q = "OLD"; expect(nodes(render(false)).find(n => n.type === "table")!.props.dataSource).toEqual([]); render();
  h.q = "NEW"; render(); await flush(); old.resolve(list(2)); await flush(); expect(props("table").dataSource).toMatchObject([{ id: 3 }]);
});
it("report date-window drilldown reaches the actual request, remains visible, and clearing removes both bounds", async () => {
  h.from = "2026-09-01"; h.to = "2026-09-11"; h.q = "SKU & 精华";
  fetchMock.mockResolvedValue(list(1)); render(); await flush();
  const query = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost").searchParams;
  expect(query.get("from")).toBe(h.from); expect(query.get("to")).toBe(h.to); expect(query.get("q")).toBe(h.q);
  const windowTag = nodes(props("toolbar").extra as ReactNode).find(n => n.props.from === h.from)!;
  expect(windowTag.props.to).toBe(h.to); (windowTag.props.onClear as () => void)(); render(); await flush();
  const cleared = new URL(String(fetchMock.mock.calls.at(-1)![0]), "http://localhost").searchParams;
  expect(cleared.has("from")).toBe(false); expect(cleared.has("to")).toBe(false); expect(cleared.get("q")).toBe(h.q);
});
it("failed list has a persistent error, no fake total, and a GET retry", async () => {
  fetchMock.mockRejectedValueOnce(Error("offline")); render(); await flush(); expect(props("table").pagination).toBe(false);
  const error = nodes(render()).find(n => n.type === "read-error" && n.props.subject === "收货列表")!;
  expect(error?.props.error).toBeTruthy(); fetchMock.mockResolvedValueOnce(list(2)); (error.props.onRetry as () => void)(); render(); await flush(); expect(props("table").dataSource).toMatchObject([{ id: 2 }]);
});
it.each(["po", "jg"])("late %s detail cannot replace current source facts", async kind => {
  const old = Promise.withResolvers<Response>(); const detail = kind === "po" ? po : jg;
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? old.promise : String(url).endsWith("/2") ? detail(2) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(kind); select(1); select(2); await flush(); old.resolve(detail(1)); await flush();
  if (kind === "po") expect(lines()?.dataSource).toMatchObject([{ skuId: 2 }, { skuId: 2 }]);
  else { expect(JSON.stringify(create())).toContain("SKU-2"); expect(JSON.stringify(create())).not.toContain("SKU-1"); }
});
it("timeout blocks creation; explicit GET retry restores current source only", async () => {
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? new Promise(() => {}) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(); select(1); await vi.advanceTimersByTimeAsync(15_000); await flush();
  const error = nodes(create()).find(n => n.type === "read-error")!; expect(error?.props.error).toContain("超时"); expect(create().props.okButtonProps).toMatchObject({ disabled: true });
  await (create().props.onOk as () => Promise<void>)(); expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  fetchMock.mockResolvedValueOnce(po(1)); (error.props.onRetry as () => void)(); render(); await flush(); expect(lines()?.dataSource).toMatchObject([{ poLineId: 11 }, { poLineId: 12 }]);
});
it("same-SKU PO lines retain separate identities and edits in a scrollable table", async () => {
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? po(1) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(); select(1); await flush();
  expect(lines()?.rowKey).toBe("poLineId"); expect(lines()?.scroll).toEqual({ x: 910 });
  const table = lines()!, rows = table.dataSource as { poLineId: number; actualQty: string }[];
  const column = (table.columns as { key: string; render: (v: unknown, r: unknown, i: number) => Node }[]).find(c => c.key === "actualQty")!;
  (column.render(null, rows[1], 1).props.onChange as (v: string) => void)("3"); render();
  expect(lines()?.dataSource).toMatchObject([{ poLineId: 11, actualQty: "0" }, { poLineId: 12, actualQty: "3" }]);
});
it.each(["wrong-id", "closed", "missing-quantity"])("%s source cannot produce editable rows", async mode => {
  fetchMock.mockImplementation(async url => {
    if (!String(url).endsWith("/1")) return Response.json({ rows: [], total: 0 });
    const data = await po(mode === "wrong-id" ? 2 : 1).json();
    if (mode === "closed") data.status = "closed";
    if (mode === "missing-quantity") delete data.lines[0].receivedQty;
    return Response.json(data);
  });
  render(); await flush(); open(); select(1); await flush();
  expect(lines()).toBeUndefined(); expect(create().props.okButtonProps).toMatchObject({ disabled: true });
  expect(nodes(create()).find(n => n.type === "read-error")?.props.error).toBeTruthy();
});

it("approval refusal persists on its own document and retry does not repeat the write", async () => {
  h.detailId = 47;
  const detail = (id: number) => Response.json({ id, docNo: `SH-${id}`, status: "pending", version: 2, sourceType: "jg", sourceId: 9, lines: [], qc: null, approvals: [], inbound: false });
  fetchMock.mockImplementation(async (url, init) => init?.method === "POST" ? Response.json({ error: "加工通知单当前状态不可操作: closed" }, { status: 409 })
    : /\/sh\/\d+$/.test(String(url)) ? detail(Number(String(url).split("/").at(-1))) : Response.json({ rows: [], total: 0 }));
  render(); await flush();
  // Invoke the real confirmation callback with a warehouse approver; browser checks cover AntD.
  const confirmations = nodes(props("drawer").extra as ReactNode).filter(n => n.type === "confirm");
  const approval = confirmations.find(n => String(n.props.title).includes("审批通过"));
  expect(approval).toBeDefined(); await (approval!.props.onConfirm as () => void)(); await flush();
  const error = nodes(render()).find(n => n.type === "alert" && n.props.message === "操作未完成，请核对当前单据")!;
  expect(error.props.description).toContain("closed");
  (nodes(error.props.action as ReactNode)[0].props.onClick as () => void)(); render(); await flush();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  h.detailId = 48; render(); await flush();
  expect(nodes(render()).some(n => n.type === "alert" && n.props.description === error.props.description)).toBe(false);
});
it("opening creates no unbounded candidate preloads; closing withdraws all source facts", async () => {
  fetchMock.mockImplementation(async url => String(url).endsWith("/1") ? po(1) : Response.json({ rows: [], total: 0 }));
  render(); await flush(); open(); expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("999"))).toBe(true);
  select(1); await flush(); (create().props.onCancel as () => void)(); render(); open(); expect(lines()).toBeUndefined();
  expect(nodes(create()).find(n => n.props.placeholder === "选择来源单据")?.props.api).toBe("/api/outsource/po?receiptEligible=1");
});
