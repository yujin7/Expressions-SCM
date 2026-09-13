import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { capacityStorageKey, clearCapacityRequest, loadCapacityRequest, lookupCapacityRequest, prepareCapacityRequest,
  submitCapacityRequest, withCapacityLock, type CapacityPayload } from "@/components/capacity-handoff-request";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8", nextKey = "ec264aa1-38a0-4803-9643-f9371545d3b9";
const payload: CapacityPayload = { skuId: 1, alertId: 2, supplierId: 3, workItemId: 4, assigneeId: 5,
  dueDate: "2090-09-20", candidateQty: "1.0001", evidenceKey: "a".repeat(64), note: "核对真实产能依据" };
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const prepare = () => prepareCapacityRequest(storage, 1, payload, undefined, () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("account-isolated bounded intent keeps decimal strings and explicit original owner", () => {
  const r = prepare(); expect(loadCapacityRequest(storage, 1)).toEqual(r); expect(loadCapacityRequest(storage, 2)).toBeNull();
  expect(r.candidateQty).toBe("1.0001"); expect(() => prepareCapacityRequest(storage, 2, { ...payload, password: "do not store" } as CapacityPayload)).toThrow();
  expect([...data.values()].join()).not.toContain("password");
});
it("unresolved request cannot be replaced by another key or different item; correction preserves identity", () => {
  const r = prepare(), generator = vi.fn(() => nextKey);
  expect(() => prepareCapacityRequest(storage, 1, payload, undefined, generator)).toThrow("尚未核对"); expect(generator).not.toHaveBeenCalled();
  expect(() => prepareCapacityRequest(storage, 1, { ...payload, workItemId: 99 }, key)).toThrow("保留原");
  expect(loadCapacityRequest(storage, 1)).toEqual(r);
  expect(prepareCapacityRequest(storage, 1, { ...payload, note: "明确修正的核对事项" }, key).requestId).toBe(key);
  expect(clearCapacityRequest(storage, 1, nextKey)?.requestId).toBe(key);
  expect(clearCapacityRequest(storage, 1, key)).toBeNull();
  expect(() => prepareCapacityRequest(storage, 1, payload, key)).toThrow("已变化");
});
it.each(["{", "x".repeat(8001), JSON.stringify({ ...payload, requestId: "bad" }), JSON.stringify({ ...payload, requestId: key, workItemId: 0 })])("corrupt recovery record blocks new save without erasure", raw => {
  data.set(capacityStorageKey(1), raw); expect(() => prepare()).toThrow("记录损坏"); expect(data.get(capacityStorageKey(1))).toBe(raw);
});
it("quota failure stops before sending", () => {
  expect(() => prepareCapacityRequest({ ...storage, setItem: () => { throw Error("quota"); } }, 1, payload)).toThrow("quota"); expect(fetch).not.toHaveBeenCalled();
});
it("cross-tab lock serializes preparation; unsupported browser does not invoke action", async () => {
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_key: string, action: () => Promise<void>) => { const run = tail.then(action); tail = run.catch(() => {}); return run; } } });
  const one = withCapacityLock(1, async () => prepare());
  const two = withCapacityLock(1, async () => prepare());
  await expect(two).rejects.toThrow("尚未核对"); expect((await one).requestId).toBe(key); expect(data.size).toBe(1);
  vi.stubGlobal("navigator", {}); const action = vi.fn(); await expect(withCapacityLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("GET distinguishes missing/saved evidence and never writes; POST retains recovery until confirmation", async () => {
  const r = prepare(), found = { requestId: key, itemId: 4, eventId: 7 };
  fetch.mockResolvedValueOnce({ ...found, eventId: null }).mockResolvedValueOnce(found);
  expect((await lookupCapacityRequest(r)).eventId).toBeNull(); expect(await lookupCapacityRequest(r)).toEqual(found);
  expect(fetch.mock.calls.every(c => c[1].method === undefined && c[1].cache === "no-store")).toBe(true);
  fetch.mockResolvedValueOnce({ itemId: 4, eventId: 7, replayed: true }); expect(await submitCapacityRequest(r)).toEqual(found);
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual(r); expect(loadCapacityRequest(storage, 1)).toEqual(r);
});
it.each([{}, { requestId: nextKey, itemId: 4, eventId: 7 }, { requestId: key, itemId: 99, eventId: 7 }, { requestId: key, itemId: 4, eventId: 0 }])("invalid readback never clears original request", async body => {
  const r = prepare(); fetch.mockResolvedValue(body); await expect(lookupCapacityRequest(r)).rejects.toThrow("未确认"); expect(loadCapacityRequest(storage, 1)).toEqual(r);
});
it("timeout is not cancellation; no automatic resend and later GET recovers", async () => {
  vi.useFakeTimers(); const r = prepare(); fetch.mockReturnValueOnce(new Promise(() => {}));
  const pending = submitCapacityRequest(r, 20), failure = expect(pending).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await failure; expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(loadCapacityRequest(storage, 1)).toEqual(r); fetch.mockResolvedValueOnce({ requestId: key, itemId: 4, eventId: 7 });
  expect((await lookupCapacityRequest(r)).eventId).toBe(7);
});
