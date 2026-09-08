import React, { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ApprovalBrief from "@/components/ApprovalBrief";
import ChainStrip from "@/components/ChainStrip";
import { useDocumentRead } from "@/components/useDocumentRead";
import Supplier360Drawer from "@/app/(app)/master/supplier/supplier-360-drawer";
import { CapacityCheckForm } from "@/components/CapacityCheckDrawer";
import dayjs from "dayjs";

// Real hook/callback lifecycle; browser tests separately verify AntD rendering and layout.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
vi.mock("antd", () => ({ DatePicker: "datepicker", InputNumber: "number", Select: "select", Alert: "alert", Card: "card", Space: "space", Table: "table", Tag: "tag", Tooltip: "tooltip", Button: "button", Drawer: "drawer", Col: "col", Row: "row", Descriptions: "descriptions", Empty: "empty", Spin: "spin", Statistic: "statistic", Typography: { Text: "text", Paragraph: "paragraph", Link: "a" } }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [hooks.slots[i], (update: T | ((old: T) => T)) => {
      const next = typeof update === "function" ? (update as (old: T) => T)(hooks.slots[i] as T) : update;
      if (!Object.is(next, hooks.slots[i])) hooks.changed = true;
      hooks.slots[i] = next;
    }];
  },
  useCallback: (fn: unknown, deps: readonly unknown[]) => {
    const i = hooks.cursor++;
    const prev = hooks.slots[i] as { fn: unknown; deps: readonly unknown[] } | undefined;
    if (!prev || prev.deps.length !== deps.length || !prev.deps.every((v, j) => Object.is(v, deps[j]))) hooks.slots[i] = { fn, deps };
    return (hooks.slots[i] as { fn: unknown }).fn;
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const i = hooks.cursor++;
    const prev = hooks.slots[i] as readonly unknown[] | undefined;
    if (prev?.length === deps.length && prev.every((v, j) => Object.is(v, deps[j]))) return;
    hooks.slots[i] = deps;
    hooks.effects.push(() => { hooks.cleanups.get(i)?.(); hooks.cleanups.delete(i); const cleanup = effect(); if (cleanup) hooks.cleanups.set(i, cleanup); });
  },
}));
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
const fetchMock = vi.fn<typeof fetch>();
let id = 1;
let surface: "brief" | "chain" | "resource" | "supplier" | "capacity" = "brief";
let supplierId: number | null = 1;
let url: string | null = "/api/outsource/bh/1";
function ResourceProbe() { return React.createElement("read", useDocumentRead<{ id: number }>(url)); }
function render(effects = true) {
  for (let n = 0; n < 10; n++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = surface === "capacity" ? CapacityCheckForm({ target: { skuId: 1, code: "FG", name: "精华", replenishHref: "/replenish/sop?q=FG" } })
      : surface === "supplier" ? Supplier360Drawer({ supplierId, onClose: () => {} }) : surface === "resource" ? ResourceProbe()
      : surface === "brief" ? ApprovalBrief({ docType: "bh", docId: id }) : ChainStrip({ docType: "bh", id });
    if (!effects) return tree;
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.changed) return tree;
  }
  throw new Error("Read did not settle");
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); };
const brief = (docNo: string) => Response.json({ docNo, origin: { fromSuggestion: false, note: "人工直录" }, lines: [], summary: { lineCount: 0, flaggedLines: 0, totalQty: 0 } });
const title = (tree = render()) => nodes(tree).find(n => n.type === "card")?.props.title ?? "";
function cleanup() { for (const fn of hooks.cleanups.values()) fn(); hooks.cleanups.clear(); }
beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.changed = false; id = 1; supplierId = 1; surface = "brief"; url = "/api/outsource/bh/1";
  fetchMock.mockReset(); vi.useFakeTimers(); vi.stubGlobal("React", React); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("withdraws the old brief before effects when a different document is selected", async () => {
  fetchMock.mockResolvedValueOnce(brief("OLD")); render(); await flush(); expect(title()).toContain("OLD");
  id = 2; expect(title(render(false))).not.toContain("OLD");
});
it("rejects out-of-order success and aborts obsolete requests", async () => {
  const old = Promise.withResolvers<Response>(); const next = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  render(); id = 2; render();
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  next.resolve(brief("CURRENT")); await flush(); old.resolve(brief("OLD")); await flush();
  expect(title()).toContain("CURRENT");
});
it("a failed previous document cannot poison the next successful brief", async () => {
  const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(brief("CURRENT"));
  render(); id = 2; render(); await flush(); old.reject(new Error("offline")); await flush();
  expect(title()).toContain("CURRENT");
});
it("offers visible failure and retry without treating missing brief as healthy", async () => {
  fetchMock.mockRejectedValueOnce(new Error("private-network-details")); render(); await flush();
  const alert = nodes(render()).find(n => n.type === "alert")!;
  expect(alert).toBeDefined(); expect(alert.props.message).toBe("审批简报暂不可用");
  expect(JSON.stringify(alert.props)).not.toContain("private-network-details");
  fetchMock.mockResolvedValueOnce(brief("RECOVERED"));
  const retry = nodes(alert.props.action as ReactNode).find(n => n.type === "button")!;
  (retry.props.onClick as () => void)(); render(); await flush(); expect(title()).toContain("RECOVERED");
});
it("times out, allows retry and never accepts a late timed-out reply", async () => {
  const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise); render();
  await vi.advanceTimersByTimeAsync(15_000); await flush();
  const alert = nodes(render()).find(n => n.type === "alert")!;
  expect(String(alert?.props.description)).toContain("超时");
  fetchMock.mockResolvedValueOnce(brief("RETRY"));
  (nodes(alert.props.action as ReactNode).find(n => n.type === "button")!.props.onClick as () => void)(); render(); await flush();
  old.resolve(brief("OLD")); await flush(); expect(title()).toContain("RETRY");
});
it.each(["brief", "chain"] as const)("%s cancels on unmount without accepting the pending response", async target => {
  surface = target; const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
  render(); cleanup(); expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  pending.resolve(brief("OLD")); await flush(); expect(title()).not.toContain("OLD");
});
it("a failed chain is visible and retryable rather than indistinguishable from no linkage", async () => {
  surface = "chain"; fetchMock.mockResolvedValueOnce(new Response("", { status: 503 })); render(); await flush();
  const alert = nodes(render()).find(n => n.type === "alert");
  expect(alert?.props.message).toBe("关联链路暂不可用");
  expect(nodes(alert?.props.action as ReactNode).some(n => n.type === "button")).toBe(true);
});

const resource = (effects = true) => nodes(render(effects)).find(n => n.type === "read")!.props;
it("chain links open an exact related identity, even when document labels repeat", async () => {
  surface = "chain";
  fetchMock.mockResolvedValueOnce(Response.json({ nodes: [
    { docType: "bh", id: 1, label: "备货", docNo: "SAME", status: "approved", statusLabel: "已审批", current: true },
    { docType: "po", id: 23, label: "采购", docNo: "SAME", status: "approved", statusLabel: "已审批", current: false },
  ] }));
  render(); await flush();
  expect(nodes(render()).filter(n => n.type === "a").map(n => n.props.href)).toEqual(["/outsource/po?docId=23"]);
});
it.each(["brief", "chain"] as const)("%s rejects malformed successful payloads without crashing or claiming no issues", async target => {
  surface = target; fetchMock.mockResolvedValueOnce(Response.json({})); render(); await flush();
  expect(nodes(render()).find(n => n.type === "alert")?.props.description).toContain("响应格式异常");
});
it("a closed detail cannot flash cached facts or actions when reopened with the same id", async () => {
  surface = "resource"; fetchMock.mockResolvedValueOnce(Response.json({ id: 1 })); render(); await flush();
  expect(resource().data).toEqual({ id: 1 });
  url = null; expect(resource().phase).toBe("idle"); expect(resource().data).toBeNull();
  url = "/api/outsource/bh/1"; expect(resource(false).data).toBeNull(); expect(resource(false).phase).toBe("loading");
});
it("refresh immediately withdraws current document data and retry uses the current id", async () => {
  surface = "resource"; fetchMock.mockResolvedValueOnce(Response.json({ id: 1 })); render(); await flush();
  const retry = resource().retry as () => void;
  fetchMock.mockReturnValueOnce(new Promise(() => {}));
  retry(); expect(resource(false).data).toBeNull(); render();
  url = "/api/outsource/bh/2"; fetchMock.mockResolvedValueOnce(Response.json({ id: 2 })); render(); await flush();
  expect(resource().data).toEqual({ id: 2 });
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(url);
});
it("a null successful response is a read failure, not endless loading or an empty document", async () => {
  surface = "resource"; fetchMock.mockResolvedValueOnce(Response.json(null)); render(); await flush();
  expect(resource().phase).toBe("error"); expect(resource().error).toBe("服务器未返回单据数据");
});
it("closing aborts a pending detail and clears its timeout", async () => {
  surface = "resource"; fetchMock.mockReturnValueOnce(new Promise(() => {})); render(); url = null; render();
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(20_000); expect(resource().phase).toBe("idle"); expect(resource().error).toBeNull();
});

const supplier = (id: number, name: string) => Response.json({
  supplier: { id, code: `QA-${id}`, name, kinds: [], status: "qualified" },
  scorecard: { windowDays: 180, minSamples: 3, row: null },
  purchaseOrders: { year: 2026, asOf: "2026-09-09", moneyVisible: false, row: null },
  paymentTerm: { year: 2026, asOf: "2026-09-09", moneyVisible: false, row: null },
  leadHistory: { source: "synthetic", state: "insufficient", row: null },
  links: { scorecard: "/score", purchaseOrders: "/purchase", paymentTerm: "/term", leadHistory: "/lead", lifecycle: `/supplier/${id}` },
});
const supplierTitle = (tree = render()) => nodes(tree).find(n => n.type === "drawer")?.props.title ?? "";
const supplierLoad = (tree = render()) => nodes(tree).find(n => typeof n.props.onRetry === "function")!.props;

it("supplier 360 withdraws prior facts and source links before a new identity effect", async () => {
  surface = "supplier"; fetchMock.mockResolvedValueOnce(supplier(1, "OLD")); render(); await flush();
  expect(supplierTitle()).toContain("OLD"); supplierId = 2;
  const tree = render(false); expect(supplierTitle(tree)).not.toContain("OLD");
  expect(JSON.stringify(tree)).not.toContain("/supplier/1");
});
it.each(["success", "failure"])("supplier 360 rejects obsolete %s after a newer response", async mode => {
  surface = "supplier"; const old = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(supplier(2, "CURRENT"));
  render(); supplierId = 2; render(); await flush();
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  if (mode === "success") old.resolve(supplier(1, "OLD")); else old.reject(new Error("old failure"));
  await flush(); expect(supplierTitle()).toContain("CURRENT"); expect(supplierLoad().error).toBeNull();
});
it("supplier 360 times out, retries the selected identity and rejects a late reply", async () => {
  surface = "supplier"; const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise);
  render(); await vi.advanceTimersByTimeAsync(15_000); await flush();
  expect(supplierLoad().error).toContain("超时");
  fetchMock.mockResolvedValueOnce(supplier(1, "RECOVERED"));
  (supplierLoad().onRetry as () => void)(); render(); await flush();
  old.resolve(supplier(1, "OLD")); await flush();
  expect(supplierTitle()).toContain("RECOVERED"); expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("supplier 360 close cancels a pending load and reopen does not resurrect old facts", async () => {
  surface = "supplier"; const old = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(old.promise);
  render(); supplierId = null; render(); expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  old.resolve(supplier(1, "OLD")); await flush(); supplierId = 1;
  expect(supplierTitle(render(false))).not.toContain("OLD");
  fetchMock.mockResolvedValueOnce(supplier(1, "REOPENED")); render(); await flush();
  expect(supplierTitle()).toContain("REOPENED");
});
it("supplier 360 failed reads remove facts and explicit retry restores the same identity", async () => {
  surface = "supplier"; fetchMock.mockRejectedValueOnce(new Error("internal-host-details")); render(); await flush();
  expect(supplierLoad().error).toBe("网络连接异常，未能获取服务器响应");
  expect(nodes(render()).some(n => n.type === "descriptions")).toBe(false);
  fetchMock.mockResolvedValueOnce(supplier(1, "RETRY")); (supplierLoad().onRetry as () => void)(); render(); await flush();
  expect(supplierTitle()).toContain("RETRY"); expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/master/supplier/1/360");
});

const capacity = (qty?: string) => Response.json({
  sku: { id: 1, code: "FG", name: "精华", baseUom: "支" },
  factories: [{ id: 2, code: "FACTORY", name: "加工厂", status: "qualified", statusLabel: "合格", hasApprovedHistory: false }],
  scenario: qty ? { supplierId: 2, dueDate: "2026-09-30", candidateQty: qty,
    signal: { scheduledQty: "900", declared: {}, explanation: "历史不足", limitations: ["不自动开单"] } } : null,
});
const capacityResult = (tree = render()) => nodes(tree).find(n => n.props["aria-label"] === "本次产能核对结果");
const capacityButton = () => nodes(render()).find(n => n.type === "button" && n.props.children === "核对产能情景")!;
function capacityChange(label: string, value: unknown) {
  const node = nodes(render()).find(n => n.props["aria-label"] === label)!;
  (node.props.onChange as (v: unknown) => void)(label === "拟交付日期" ? dayjs(String(value)) : value);
}
async function prepareCapacity() {
  surface = "capacity"; fetchMock.mockResolvedValueOnce(capacity()); render(); await flush();
  expect(capacityButton().props.disabled).toBe(true);
  capacityChange("加工厂", 2); capacityChange("拟交付日期", "2026-09-30"); capacityChange("拟新增量", "200"); render();
  expect(fetchMock).toHaveBeenCalledTimes(1);
}
it("capacity waits for explicit submission and withdraws old results before an edited-input effect", async () => {
  await prepareCapacity(); fetchMock.mockResolvedValueOnce(capacity("200"));
  (capacityButton().props.onClick as () => void)(); render(); await flush(); expect(capacityResult()).toBeDefined();
  capacityChange("拟新增量", "300"); expect(capacityResult(render(false))).toBeUndefined(); render();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  capacityChange("拟新增量", "200"); expect(capacityResult()).toBeUndefined();
});
it("capacity cancels a pending scenario on edits and rejects its late response", async () => {
  await prepareCapacity(); const pending = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
  (capacityButton().props.onClick as () => void)(); render();
  capacityChange("拟交付日期", "2026-10-01"); render();
  expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
  pending.resolve(capacity("200")); await flush(); expect(capacityResult()).toBeUndefined();
});
it("capacity failure remains retryable without changing the selected scenario", async () => {
  await prepareCapacity(); fetchMock.mockRejectedValueOnce(new Error("private-details"));
  (capacityButton().props.onClick as () => void)(); render(); await flush();
  const failure = nodes(render()).find(n => n.props.subject === "产能情景")!;
  expect(failure.props.error).toBe("网络连接异常，未能获取服务器响应"); expect(capacityResult()).toBeUndefined();
  fetchMock.mockResolvedValueOnce(capacity("200")); (failure.props.onRetry as () => void)(); render(); await flush();
  expect(capacityResult()).toBeDefined(); expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[2][0]);
});
it("capacity withdraws results when date editing begins before DatePicker commits a new date", async () => {
  await prepareCapacity(); fetchMock.mockResolvedValueOnce(capacity("200"));
  (capacityButton().props.onClick as () => void)(); render(); await flush(); expect(capacityResult()).toBeDefined();
  const root = nodes(render())[0];
  expect(root.props.style).toMatchObject({ gridTemplateColumns: "minmax(0, 1fr)", minWidth: 0 });
  (nodes(render()).find(n => n.props["aria-label"] === "拟交付日期")!.props.onFocus as () => void)();
  expect(capacityResult(render(false))).toBeUndefined();
  expect(capacityButton().props["aria-label"]).toBe("核对产能情景");
});
