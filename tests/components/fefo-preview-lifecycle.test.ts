import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { isValidElement, type ReactNode } from "react";
import { currentFefoPreviewKey, fefoPreviewKey, useFefoPreview, type FefoPreviewGroup } from "@/components/useFefoPreview";
import { FefoPreviewModal } from "@/app/(app)/inventory/docs/FefoPreviewModal";
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useCallback: (fn: unknown, deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as { fn: unknown; deps: readonly unknown[] } | undefined;
    if (!p || p.deps.length !== deps.length || !p.deps.every((v, j) => Object.is(v, deps[j]))) h.slots[i] = { fn, deps }; return (h.slots[i] as { fn: unknown }).fn; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as readonly unknown[] | undefined;
    if (p?.length === deps.length && p.every((v, j) => Object.is(v, deps[j]))) return; h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
vi.mock("antd", () => ({ Modal: "modal", Table: "table", Space: "space", Tag: "tag", Alert: "alert", Typography: { Text: "text" } }));
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetcher }));
let target: string | null, current: string | null;
const input = { subtype: "sales_out", warehouseId: 2, lines: [{ skuId: 1, qty: "0.1" }, { skuId: 1, qty: "0.2" }] };
const group = (skuId = 1): FefoPreviewGroup => ({ skuId, warehouseId: 2, skuCode: `SKU-${skuId}`, skuName: "合成物料", baseUom: "kg", sourceQuantities: ["0.1", "0.2"], sourceBatchIds: [null, null], mode: "automatic",
  riskDisposalId: null, requestedQty: "0.3000", allocations: [{ batchId: 5, batchNo: "LOT-5", expiryDate: "2028-01-01", qty: "0.3000" }], fallbackQty: "0.0000", shortBy: "0.0000", expiredLots: 0, batchCoverage: true, note: "只读" });
function PreviewFixture() { return useFefoPreview(target, current); }
function render(effects = true): ReturnType<typeof useFefoPreview> { for (let i = 0; i < 12; i++) { h.cursor = 0; h.changed = false; const value = PreviewFixture(); if (!effects) return value;
  for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return value; } throw Error("render did not settle"); }
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); return render(); };
beforeEach(() => { h.cursor = 0; h.slots = []; h.effects = []; h.cleanups.clear(); h.changed = false; target = current = fefoPreviewKey(input); fetcher.mockReset(); vi.stubGlobal("React", React); });
afterEach(() => { for (const fn of h.cleanups.values()) fn(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("sends exact independent quantities, never browser float totals, and binds identity", async () => {
  fetcher.mockResolvedValue(group()); render(); const r = await flush(); expect(r.groups).toEqual([group()]);
  const p = new URL(String(fetcher.mock.calls[0][0]), "http://test").searchParams;
  expect(p.getAll("qty")).toEqual(["0.1", "0.2"]); expect(p.getAll("batchId")).toEqual(["auto", "auto"]); expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
});
it.each(["0", "-1", "0.00001", "1e3", "NaN", "10000000000"])("invalid input %s cannot produce confirmable identity", qty => {
  expect(currentFefoPreviewKey({ ...input, lines: [{ skuId: 1, qty }] })).toBeNull();
});
it("different warehouse withdraws old facts before effect cleanup; late response stays discarded", async () => {
  const old = Promise.withResolvers<unknown>(); fetcher.mockReturnValue(old.promise); render();
  current = fefoPreviewKey({ ...input, warehouseId: 3 }); expect(render(false)).toMatchObject({ groups: null, loading: false });
  render(); old.resolve(group()); expect((await flush()).groups).toBeNull(); expect(render().error).toContain("已变化");
});
it("quantity, line order and explicit batch changes create different confirmation identities", () => {
  expect(fefoPreviewKey({ ...input, subtype: "issue_out", riskDisposalId: 7 })).not.toBe(target);
  for (const lines of [[{ skuId: 1, qty: "0.3" }], [...input.lines].reverse(), [{ skuId: 1, qty: "0.1", batchId: 5 }, input.lines[1]]]) expect(fefoPreviewKey({ ...input, lines })).not.toBe(target);
});
it("failed retry clears previous successful groups and exposes an actionable error", async () => {
  fetcher.mockResolvedValueOnce(group()).mockRejectedValueOnce(Error("数据库暂不可用")); render(); await flush(); render().retry();
  expect(render(false).groups).toBeNull(); render(); expect(await flush()).toMatchObject({ groups: null, loading: false, error: "数据库暂不可用" });
});
it("partial SKU failure is all-or-nothing and retry only reads", async () => {
  target = current = fefoPreviewKey({ ...input, lines: [...input.lines, { skuId: 2, qty: "1" }] });
  fetcher.mockImplementation(async url => String(url).includes("skuId=2") ? Promise.reject(Error("第二SKU失败")) : group()); render(); expect((await flush()).groups).toBeNull();
  fetcher.mockImplementation(async url => String(url).includes("skuId=2") ? { ...group(2), sourceQuantities: ["1"], sourceBatchIds: [null], requestedQty: "1.0000" } : group());
  render().retry(); render(); expect((await flush()).groups).toHaveLength(2); expect(fetcher.mock.calls.every(c => c[1].method == null)).toBe(true);
});
it.each([{}, { warehouseId: 3 }, { skuId: 9 }, { sourceQuantities: ["9"] }, { sourceBatchIds: [5, 6] }, { mode: "explicit" }, { riskDisposalId: 7 }])("malformed or mismatched result cannot be confirmed (%j)", changed => {
  fetcher.mockResolvedValue(Object.keys(changed).length ? { ...group(), ...changed } : {}); render(); return flush().then(r => { expect(r.groups).toBeNull(); expect(r.error).toBeTruthy(); });
});
it("timeout is bounded, aborts old read, and a late success cannot clear the error", async () => {
  vi.useFakeTimers(); const late = Promise.withResolvers<unknown>(); fetcher.mockReturnValue(late.promise); render(); await vi.advanceTimersByTimeAsync(15000);
  expect(render()).toMatchObject({ groups: null, loading: false }); expect(render().error).toContain("超时"); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  late.resolve(group()); expect((await flush()).groups).toBeNull();
});
it("closing a preview aborts it and reopening the same input does not reuse prior facts", async () => {
  fetcher.mockResolvedValue(group()); render(); await flush(); target = null; expect(render().groups).toBeNull(); target = current;
  fetcher.mockReturnValue(new Promise(() => {})); expect(render().groups).toBeNull();
});
it("explicit lots stay explicit in the request and verified result", async () => {
  target = current = fefoPreviewKey({ ...input, lines: [{ skuId: 1, qty: "0.3", batchId: 5 }] });
  fetcher.mockResolvedValue({ ...group(), sourceQuantities: ["0.3"], sourceBatchIds: [5], mode: "explicit" }); render(); expect((await flush()).groups?.[0].mode).toBe("explicit");
  expect(new URL(fetcher.mock.calls[0][0], "http://test").searchParams.getAll("batchId")).toEqual(["5"]);
});
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (v: ReactNode): Node[] => Array.isArray(v) ? v.flatMap(nodes) : isValidElement<Node["props"]>(v) ? [v, ...nodes(v.props.children)] : [];
it.each(["loading", "error", "empty", "shortage"])("modal cannot confirm %s, including direct stale callbacks", state => {
  const confirm = vi.fn(); const tree = FefoPreviewModal({ open: true, loading: state === "loading", error: state === "error" ? "失败" : null,
    groups: state === "empty" ? [] : [{ ...group(), shortBy: state === "shortage" ? "0.1" : "0" }], onCancel: vi.fn(), onConfirm: confirm, onRetry: vi.fn() });
  expect(tree.props.okButtonProps.disabled).toBe(true); tree.props.onOk(); expect(confirm).not.toHaveBeenCalled();
  if (state === "error" || state === "loading") expect(nodes(tree).find(n => n.type === "table")!.props.dataSource).toEqual([]);
});
it("successful complete preview can be acknowledged without posting from modal", () => {
  const confirm = vi.fn(); const tree = FefoPreviewModal({ open: true, loading: false, error: null, groups: [group()], onCancel: vi.fn(), onConfirm: confirm, onRetry: vi.fn() });
  expect(tree.props.okButtonProps.disabled).toBe(false); tree.props.onOk(); expect(confirm).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
});
it("pending read keeps cancellation independent of the loading confirmation button", () => {
  const cancel = vi.fn(); const tree = FefoPreviewModal({ open: true, loading: true, error: null, groups: null, onCancel: cancel, onConfirm: vi.fn(), onRetry: vi.fn() });
  expect(tree.props).not.toHaveProperty("confirmLoading"); expect(tree.props.okButtonProps.loading).toBe(true);
  tree.props.onCancel(); expect(cancel).toHaveBeenCalledOnce();
});
