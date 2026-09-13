import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { isValidElement, type ReactNode } from "react";
import { expiryReferenceKey, useExpiryReference, type ExpiryReferenceData } from "@/components/useExpiryReference";
import ExpiryReferenceNotice from "@/components/ExpiryReferenceNotice";
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[], cleanups: new Map<number, () => void>(), changed: false }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T | (() => T)) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [h.slots[i], (update: T | ((old: T) => T)) => { const v = typeof update === "function" ? (update as (old: T) => T)(h.slots[i] as T) : update; if (!Object.is(v, h.slots[i])) h.changed = true; h.slots[i] = v; }]; },
  useCallback: (fn: unknown, deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as { fn: unknown; deps: readonly unknown[] } | undefined;
    if (!p || p.deps.length !== deps.length || !p.deps.every((v, j) => Object.is(v, deps[j]))) h.slots[i] = { fn, deps }; return (h.slots[i] as { fn: unknown }).fn; },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => { const i = h.cursor++; const p = h.slots[i] as readonly unknown[] | undefined;
    if (p?.length === deps.length && p.every((v, j) => Object.is(v, deps[j]))) return; h.slots[i] = deps; h.effects.push(() => { h.cleanups.get(i)?.(); h.cleanups.delete(i); const cleanup = fn(); if (cleanup) h.cleanups.set(i, cleanup); }); },
}));
vi.mock("antd", () => ({ Alert: "alert", Button: "button" }));
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetcher }));
let target: string | null;
const key = (warehouseId = 2, ids = [1]) => expiryReferenceKey(true, warehouseId, ids.map(skuId => ({ skuId })));
const data = (ids = [1], warehouseId = 2): ExpiryReferenceData => ({ source: "batch_stock_reference", today: "2026-09-14", warehouseId,
  items: ids.map(skuId => ({ skuId, skuCode: `SKU-${skuId}`, skuKnown: true, baseUom: "kg", thresholdDays: 90, referenceRows: 2, nearBatches: 2,
    undatedPositiveRows: 0, minDaysLeft: -1, stocktakeDates: ["2026-09-01"], stocktakeAgeDays: 13, nearQtyExact: "0.3000", expiredQtyExact: "0.1000" })) });
function ReferenceFixture() { return useExpiryReference(target); }
function render(effects = true): ReturnType<typeof useExpiryReference> { for (let i = 0; i < 12; i++) { h.cursor = 0; h.changed = false; const value = ReferenceFixture(); if (!effects) return value;
  for (const fn of h.effects.splice(0)) fn(); if (!h.changed) return value; } throw Error("render did not settle"); }
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); return render(); };
const start = async () => { render(); await vi.advanceTimersByTimeAsync(500); return flush(); };
beforeEach(() => { h.cursor = 0; h.slots = []; h.effects = []; h.cleanups.clear(); h.changed = false; target = key(); fetcher.mockReset(); vi.stubGlobal("React", React); vi.useFakeTimers(); });
afterEach(() => { for (const fn of h.cleanups.values()) fn(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("debounces and deduplicates quantity/order changes, uses uncached read", async () => {
  fetcher.mockResolvedValue(data()); render(); await vi.advanceTimersByTimeAsync(499); expect(fetcher).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect((await flush()).data).toEqual(data());
  target = expiryReferenceKey(true, 2, [{ skuId: 1, qty: "0.2" }, { skuId: 1, qty: "0.1" }]);
  render(); await vi.advanceTimersByTimeAsync(1000); expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
});
it("201 SKU scope reads both chunks and publishes only the complete result", async () => {
  const ids = Array.from({ length: 201 }, (_, i) => i + 1); target = key(2, ids);
  fetcher.mockImplementation(async url => data(new URL(url, "http://test").searchParams.get("skuIds")!.split(",").map(Number)));
  expect((await start()).data?.items).toHaveLength(201); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("a partial chunk failure publishes no risk facts and retry rereads all chunks", async () => {
  target = key(2, Array.from({ length: 201 }, (_, i) => i + 1));
  fetcher.mockImplementation(async url => { const ids = new URL(url, "http://test").searchParams.get("skuIds")!.split(",").map(Number); if (ids[0] === 201) throw Error("第二批失败"); return data(ids); });
  expect(await start()).toMatchObject({ phase: "error", data: null, error: "第二批失败" });
  fetcher.mockImplementation(async url => data(new URL(url, "http://test").searchParams.get("skuIds")!.split(",").map(Number)));
  render().retry(); expect(render(false).data).toBeNull(); expect((await start()).data?.items).toHaveLength(201);
  expect(fetcher.mock.calls.every(c => c[1].method == null)).toBe(true);
});
it("warehouse changes withdraw old success immediately; late previous request cannot replace new facts", async () => {
  const late = Promise.withResolvers<unknown>(); fetcher.mockReturnValueOnce(late.promise).mockResolvedValueOnce(data([1], 3)); await start();
  target = key(3); expect(render(false)).toMatchObject({ phase: "loading", data: null }); expect((await start()).data?.warehouseId).toBe(3);
  late.resolve(data()); expect((await flush()).data?.warehouseId).toBe(3); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
it("clearing or closing aborts reads and reopening never reuses prior success", async () => {
  fetcher.mockResolvedValue(data()); await start(); target = null; expect(render()).toMatchObject({ phase: "idle", data: null });
  target = key(); expect(render(false)).toMatchObject({ phase: "loading", data: null }); await start(); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("timeout aborts and cannot later turn into no-risk success", async () => {
  const late = Promise.withResolvers<unknown>(); fetcher.mockReturnValue(late.promise); await start(); await vi.advanceTimersByTimeAsync(15000);
  expect(render()).toMatchObject({ phase: "error", data: null }); expect(render().error).toContain("超时"); late.resolve(data()); expect((await flush()).phase).toBe("error");
});
it.each([{}, { ...data(), warehouseId: 3 }, { ...data(), items: [] }, { ...data(), source: "ledger" }, { ...data(), items: [data([9]).items[0]] }, { ...data(), items: [{ ...data().items[0], nearQtyExact: "NaN" }] }])("malformed or mismatched response is explicit failure (%j)", async value => {
  fetcher.mockResolvedValue(value); expect(await start()).toMatchObject({ phase: "error", data: null });
});
it("duplicate response members and cross-day chunks are rejected", async () => {
  target = key(2, [1, 2]); fetcher.mockResolvedValue(data([1, 1])); expect((await start()).phase).toBe("error");
  target = key(2, Array.from({ length: 201 }, (_, i) => i + 1));
  fetcher.mockImplementation(async url => { const ids = new URL(url, "http://test").searchParams.get("skuIds")!.split(",").map(Number); return { ...data(ids), today: ids[0] === 201 ? "2026-09-15" : "2026-09-14" }; });
  expect((await start()).error).toContain("跨越业务日");
});
it("large scope gives an actionable limit instead of partial display", async () => {
  target = key(2, Array.from({ length: 1001 }, (_, i) => i + 1)); expect((await start()).error).toContain("拆分单据"); expect(fetcher).not.toHaveBeenCalled();
});
it("inapplicable or incomplete input does not fetch", async () => {
  expect(expiryReferenceKey(false, 2, [{ skuId: 1 }])).toBeNull(); expect(expiryReferenceKey(true, 0, [{ skuId: 1 }])).toBeNull();
  target = expiryReferenceKey(true, 2, [{ skuId: null }]); expect((await start()).phase).toBe("idle"); expect(fetcher).not.toHaveBeenCalled();
});
type Node = React.ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const text = (v: ReactNode): string => Array.isArray(v) ? v.map(text).join("") : isValidElement<Node["props"]>(v) ? text(v.props.children) : v == null || typeof v === "boolean" ? "" : String(v);
const notice = (payload: ExpiryReferenceData) => ExpiryReferenceNotice({ read: { phase: "success", data: payload, error: null, retry: vi.fn() } })!;
it("notice carries source, actual unit, exact totals, observation date and informational boundary", () => {
  const tree = notice(data()); const content = text(tree.props.description);
  expect(tree.props.type).toBe("warning"); for (const word of ["非实时库存", "2026-09-01", "0.3000 kg", "13 天", "不单独拦截"]) expect(content).toContain(word);
  expect(content).not.toContain("件");
});
it("missing/undated/future references stay visible and do not become a healthy zero", () => {
  const payload = data([1, 2, 3]); payload.items[0] = { ...payload.items[0], referenceRows: 0, nearBatches: 0, stocktakeDates: [] };
  payload.items[1].undatedPositiveRows = 1; payload.items[2].stocktakeDates = ["2999-01-01"];
  const tree = notice(payload); expect(tree.props.type).toBe("warning"); const content = text(tree.props.description);
  for (const word of ["不能据此认定无风险", "缺少效期", "未来盘点日期"]) expect(content).toContain(word);
  const clean = data(); clean.items[0].nearBatches = 0; expect(notice(clean).props.type).toBe("info");
});
