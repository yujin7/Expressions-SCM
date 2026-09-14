import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stockCreateStorageKey, clearStockCreateRequest, loadStockCreateRequest, lookupStockCreateRequest, prepareStockCreateRequest, submitStockCreateRequest, cancelStockCreateRequest, withStockCreateLock, type StockCreatePayload } from "@/components/stock-create-request";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ee392149-8738-4e50-992f-f565bba7f911", next = "ee392149-8738-4e50-992f-f565bba7f912";
const payload: StockCreatePayload = { subtype: "opening", warehouseId: 3, lines: [{ skuId: 7, qty: "3.0001", price: "1.23", batchId: 9 }, { skuId: 7, qty: "2" }] };
const document = { id: 17, docNo: "RK-20260914-0001", status: "draft" };
const receipt = { requestKey: key, document };
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const prepare = () => prepareStockCreateRequest(storage, 1, payload, undefined, () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("preserves exact decimal, lot and independent line identity without storing unrelated secrets", () => {
  prepareStockCreateRequest(storage, 1, { ...payload, password: "never-store" } as StockCreatePayload, undefined, () => key.toUpperCase());
  expect(loadStockCreateRequest(storage, 1)).toEqual({ ...payload, requestKey: key });
  expect(loadStockCreateRequest(storage, 2)).toBeNull();
  expect([...data.values()].join()).not.toContain("password"); expect(fetch).not.toHaveBeenCalled();
});
it("all entry points share one unresolved account intent and cannot allocate another key", () => {
  const first = prepare(), generate = vi.fn(() => next);
  expect(prepareStockCreateRequest(storage, 1, { ...payload, subtype: "transfer", toWarehouseId: 4 }, undefined, generate)).toEqual(first);
  expect(generate).not.toHaveBeenCalled();
});
it("explicit repair keeps the key; stale editing and clears cannot erase a different request", () => {
  prepare(); expect(prepareStockCreateRequest(storage, 1, { ...payload, remark: "更正" }, key).requestKey).toBe(key);
  expect(clearStockCreateRequest(storage, 1, next)?.remark).toBe("更正");
  expect(clearStockCreateRequest(storage, 1, key)).toBeNull();
  expect(() => prepareStockCreateRequest(storage, 1, payload, key)).toThrow("已变化");
  const newer = prepareStockCreateRequest(storage, 1, payload, undefined, () => next);
  expect(clearStockCreateRequest(storage, 1, key)).toEqual(newer);
});
it.each(["{", "x".repeat(100001), JSON.stringify({ ...payload, requestKey: "bad" }), JSON.stringify({ ...payload, requestKey: key, lines: [] })])("damaged storage blocks replacement without deleting evidence", raw => {
  data.set(stockCreateStorageKey(1), raw); expect(() => prepare()).toThrow("损坏"); expect(data.get(stockCreateStorageKey(1))).toBe(raw);
});
it("quota failure occurs before submission", () => {
  expect(() => prepareStockCreateRequest({ ...storage, setItem: () => { throw Error("quota"); } }, 1, payload, undefined, () => key)).toThrow("quota");
  expect(fetch).not.toHaveBeenCalled();
});
it("serializes same-account cross-tab allocation; unsupported browsers cannot invoke writes", async () => {
  let tail = Promise.resolve(); const names: string[] = [];
  vi.stubGlobal("navigator", { locks: { request: (name: string, fn: () => Promise<unknown>) => {
    names.push(name); const run = tail.then(fn); tail = run.then(() => undefined); return run;
  } } });
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const first = withStockCreateLock(1, async () => { const r = prepare(); started.resolve(); await gate.promise; return r; });
  await started.promise;
  const second = withStockCreateLock(1, async () => prepareStockCreateRequest(storage, 1, payload, undefined, () => next));
  gate.resolve(); expect(await first).toEqual(await second); expect(names).toEqual([stockCreateStorageKey(1), stockCreateStorageKey(1)]);
  vi.stubGlobal("navigator", {}); const action = vi.fn();
  await expect(withStockCreateLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("creation validates POST then independently reads current state, not an assumed draft", async () => {
  const request = prepare(); fetch.mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ...receipt, document: { ...document, status: "void" } });
  expect((await submitStockCreateRequest(request)).document?.status).toBe("void");
  expect(fetch.mock.calls[0][0]).toBe("/api/inventory/stock-doc");
  expect(fetch.mock.calls[0][1].headers["x-scm-stock-create-contract"]).toBe("2");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
  expect(fetch.mock.calls[1][1].cache).toBe("no-store"); expect(loadStockCreateRequest(storage, 1)).toEqual(request);
});
it("replacement identity survives storage and payload repair without leaking into an ordinary next request", () => {
  const original = prepareStockCreateRequest(storage, 1, { ...payload, replacementOfId: 11 }, undefined, () => key);
  expect(loadStockCreateRequest(storage, 1)?.replacementOfId).toBe(11);
  expect(prepareStockCreateRequest(storage, 1, { ...original, remark: "改正数量" }, key).replacementOfId).toBe(11);
  clearStockCreateRequest(storage, 1, key); expect(prepareStockCreateRequest(storage, 1, payload, undefined, () => next).replacementOfId).toBeUndefined();
});
it("not-found lookup is read-only and retains original request", async () => {
  const request = prepare(); fetch.mockResolvedValue({ requestKey: key, document: null });
  expect((await lookupStockCreateRequest(key)).document).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].method).toBeUndefined(); expect(loadStockCreateRequest(storage, 1)).toEqual(request);
});
it.each([{}, { ...receipt, requestKey: next }, { ...receipt, document: null }, { ...receipt, document: { ...document, docNo: "/evil" } }])("invalid results never discard original intent", async response => {
  const request = prepare(); fetch.mockResolvedValue(response); await expect(submitStockCreateRequest(request)).rejects.toThrow(); expect(loadStockCreateRequest(storage, 1)).toEqual(request);
});
it("a mismatched second read fails closed", async () => {
  const request = prepare(); fetch.mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ...receipt, document: { ...document, id: 18 } });
  await expect(submitStockCreateRequest(request)).rejects.toThrow("状态尚未确认"); expect(loadStockCreateRequest(storage, 1)).toEqual(request);
});
it("timeout retains intent; later read recovers a late commit without automatic POST", async () => {
  vi.useFakeTimers(); const request = prepare(), late = Promise.withResolvers<unknown>(); fetch.mockReturnValue(late.promise);
  const submit = submitStockCreateRequest(request, 20), assertion = expect(submit).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await assertion; expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  late.resolve(receipt); fetch.mockResolvedValue(receipt); expect((await lookupStockCreateRequest(key)).document).toEqual(document);
  expect(fetch).toHaveBeenCalledTimes(2); expect(loadStockCreateRequest(storage, 1)).toEqual(request);
});
it.each(["inventory/docs/docs-client.tsx", "report/transfer-suggest/transfer-suggest-client.tsx", "replenish/move-or-buy/move-or-buy-client.tsx"])("%s uses shared persistent recovery instead of direct unkeyed creation", path => {
  const source = readFileSync(`src/app/(app)/${path}`, "utf8");
  expect(source).toContain("useStockCreateRecovery"); expect(source).toContain("<StockCreateRecovery");
  expect(source).not.toMatch(/postJson[^\n]*["']\/api\/inventory\/stock-doc["']/);
  expect(source).toContain("key={");
  expect(source).toContain("onAcknowledged=");
});

it("cancellation first reads, posts only the original key, verifies outcome, and retains recovery data", async () => {
  const original = prepare(), cancelled = { requestKey: key, document: null, cancelled: true };
  fetch.mockResolvedValueOnce({ requestKey: key, document: null }).mockResolvedValueOnce(cancelled).mockResolvedValueOnce(cancelled);
  expect(await cancelStockCreateRequest(key)).toEqual(cancelled);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([`/api/inventory/stock-doc/create-result?requestKey=${key}`, "/api/inventory/stock-doc/cancel-create", `/api/inventory/stock-doc/create-result?requestKey=${key}`]);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ requestKey: key }); expect(loadStockCreateRequest(storage, 1)).toEqual(original);
});
it.each([receipt, { requestKey: key, document: null, cancelled: true }])("known terminal result never sends another cancellation", async found => {
  prepare(); fetch.mockResolvedValue(found); expect(await cancelStockCreateRequest(key)).toEqual(found); expect(fetch).toHaveBeenCalledTimes(1);
});
it("creation winning during cancellation returns its document", async () => {
  fetch.mockResolvedValueOnce({ requestKey: key, document: null }).mockResolvedValueOnce(receipt).mockResolvedValueOnce(receipt);
  expect(await cancelStockCreateRequest(key)).toEqual(receipt);
});
it.each([{ requestKey: key, document: null }, { ...receipt, cancelled: true }, { requestKey: key, document: null, cancelled: false }])("ambiguous cancellation never permits clearing", async bad => {
  const original = prepare(); fetch.mockResolvedValueOnce({ requestKey: key, document: null }).mockResolvedValueOnce(bad);
  await expect(cancelStockCreateRequest(key)).rejects.toThrow(); expect(loadStockCreateRequest(storage, 1)).toEqual(original);
});
it("lost cancellation reply can be found via GET, without losing the local intent", async () => {
  const original = prepare(), cancelled = { requestKey: key, document: null, cancelled: true };
  fetch.mockResolvedValueOnce({ requestKey: key, document: null }).mockRejectedValueOnce(Error("cancel reply lost"));
  await expect(cancelStockCreateRequest(key)).rejects.toThrow("cancel reply lost"); expect(loadStockCreateRequest(storage, 1)).toEqual(original);
  fetch.mockResolvedValueOnce(cancelled); expect(await lookupStockCreateRequest(key)).toEqual(cancelled);
});
