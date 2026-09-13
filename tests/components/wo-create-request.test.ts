import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearWoCreateRequest, loadWoCreateRequest, lookupWoCreateRequest, prepareWoCreateRequest, submitWoCreateRequest, withWoCreateLock, type WoCreatePayload } from "@/components/wo-create-request";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ee392149-8738-4e50-992f-f565bba7f911";
const nextKey = "ee392149-8738-4e50-992f-f565bba7f912";
const payload: WoCreatePayload = { productSkuId: 7, supplierId: 8, qty: "3.0001", feeRatePlan: "1.25" };
const document = { id: 17, docNo: "WO-20260913-0001", status: "draft" };
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const prepare = () => prepareWoCreateRequest(storage, 1, payload, undefined, () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("persists only bounded business intent, isolated per account, and restores exact decimal strings", () => {
  const request = prepareWoCreateRequest(storage, 1, { ...payload, password: "must-not-store" } as WoCreatePayload, undefined, () => key.toUpperCase());
  expect(loadWoCreateRequest(storage, 1)).toEqual({ ...payload, requestKey: key });
  expect(loadWoCreateRequest(storage, 2)).toBeNull();
  expect(JSON.stringify(request)).not.toContain("password");
});
it("another tab cannot replace an unresolved request or allocate another key", () => {
  const first = prepare(); const generate = vi.fn(() => nextKey);
  expect(prepareWoCreateRequest(storage, 1, { ...payload, qty: "999" }, undefined, generate)).toEqual(first);
  expect(generate).not.toHaveBeenCalled();
});
it("explicit editing retains the key; stale editing and late clears cannot affect another intent", () => {
  prepare(); expect(prepareWoCreateRequest(storage, 1, { ...payload, qty: "4" }, key).requestKey).toBe(key);
  expect(clearWoCreateRequest(storage, 1, nextKey)?.qty).toBe("4");
  expect(clearWoCreateRequest(storage, 1, key)).toBeNull();
  expect(() => prepareWoCreateRequest(storage, 1, payload, key)).toThrow("已变化");
  const next = prepareWoCreateRequest(storage, 1, payload, undefined, () => nextKey);
  expect(clearWoCreateRequest(storage, 1, key)).toEqual(next);
});
it.each(["{", "x".repeat(5001), JSON.stringify({ ...payload, requestKey: "bad" }), JSON.stringify({ ...payload, requestKey: key, qty: "0" }), JSON.stringify({ ...payload, requestKey: key, feeRatePlan: "1.001" })])("corrupt or out-of-contract storage blocks replacement without deleting it", raw => {
  data.set("scm:wo-create:v1:1", raw);
  expect(() => prepare()).toThrow(); expect(data.get("scm:wo-create:v1:1")).toBe(raw);
});
it("storage access/quota failure propagates before a request can be sent", () => {
  expect(() => prepareWoCreateRequest({ ...storage, setItem: () => { throw Error("quota"); } }, 1, payload, undefined, () => key)).toThrow("quota");
  expect(fetch).not.toHaveBeenCalled(); expect(loadWoCreateRequest(storage, 1)).toBeNull();
});
it("serializes cross-tab allocation with the account lock", async () => {
  let tail = Promise.resolve(); const names: string[] = [];
  vi.stubGlobal("navigator", { locks: { request: (name: string, fn: () => Promise<unknown>) => {
    names.push(name); const run = tail.then(fn); tail = run.then(() => undefined); return run;
  } } });
  const gate = Promise.withResolvers<void>(); const started = Promise.withResolvers<void>();
  const first = withWoCreateLock(1, async () => { const r = prepare(); started.resolve(); await gate.promise; return r; });
  await started.promise;
  const other = vi.fn(() => nextKey);
  const second = withWoCreateLock(1, async () => prepareWoCreateRequest(storage, 1, payload, undefined, other));
  gate.resolve(); expect(await first).toEqual(await second); expect(other).not.toHaveBeenCalled();
  expect(names).toEqual(["scm:wo-create:v1:1", "scm:wo-create:v1:1"]);
});
it("unsupported browsers cannot run the creation action", async () => {
  vi.stubGlobal("navigator", {}); const action = vi.fn();
  await expect(withWoCreateLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("POST accepts only a matching receipt and GET supports an explicit not-yet-found result", async () => {
  const request = prepare(); fetch.mockResolvedValueOnce({ requestKey: key, document });
  expect(await submitWoCreateRequest(request)).toEqual({ requestKey: key, document });
  expect(fetch.mock.calls[0][0]).toBe("/api/outsource/wo"); expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
  fetch.mockResolvedValueOnce({ requestKey: key, document: null });
  expect(await lookupWoCreateRequest(key)).toEqual({ requestKey: key, document: null });
  expect(fetch.mock.calls[1][1].cache).toBe("no-store"); expect(loadWoCreateRequest(storage, 1)).toEqual(request);
});
it.each([{ requestKey: nextKey, document }, { requestKey: key, document: null }, { requestKey: key, document: { ...document, id: 0 } }, { requestKey: key, document: { ...document, docNo: "/evil" } }, {}])("invalid creation responses retain recovery intent", async response => {
  const request = prepare(); fetch.mockResolvedValue(response);
  await expect(submitWoCreateRequest(request)).rejects.toThrow("结果格式异常"); expect(loadWoCreateRequest(storage, 1)).toEqual(request);
});
it("timeout aborts the response wait but retains the original intent for late-commit recovery", async () => {
  vi.useFakeTimers(); const request = prepare(); const late = Promise.withResolvers<unknown>(); fetch.mockReturnValue(late.promise);
  const submit = submitWoCreateRequest(request, 20); const assertion = expect(submit).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await assertion;
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(loadWoCreateRequest(storage, 1)).toEqual(request);
  late.resolve({ requestKey: key, document }); fetch.mockResolvedValue({ requestKey: key, document });
  expect((await lookupWoCreateRequest(key)).document).toEqual(document);
});
it("invalid lookup keys stop before HTTP", async () => { await expect(lookupWoCreateRequest("bad")).rejects.toThrow("编号无效"); expect(fetch).not.toHaveBeenCalled(); });
