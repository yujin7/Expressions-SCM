import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bhCreateStorageKey, clearBhCreateRequest, loadBhCreateRequest, lookupBhCreateRequest, prepareBhCreateRequest, submitBhCreateRequest, withBhCreateLock, type BhCreatePayload } from "@/components/bh-create-request";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ee392149-8738-4e50-992f-f565bba7f911", next = "ee392149-8738-4e50-992f-f565bba7f912";
const payload: BhCreatePayload = { source: "manual", remark: "核对", lines: [{ skuId: 7, qty: "3.0001", expectDate: "2026-10-12" }, { skuId: 7, qty: "2" }] };
const document = { id: 17, docNo: "BH-20260913-0001", status: "draft" };
const receipt = { requestKey: key, source: "manual", document };
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const prepare = () => prepareBhCreateRequest(storage, 1, payload, undefined, () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("stores only bounded original intent, preserving independent same-SKU lines and account isolation", () => {
  prepareBhCreateRequest(storage, 1, { ...payload, password: "never-store" } as BhCreatePayload, undefined, () => key.toUpperCase());
  expect(loadBhCreateRequest(storage, 1)).toEqual({ ...payload, requestKey: key });
  expect(loadBhCreateRequest(storage, 2)).toBeNull();
  expect([...data.values()].join()).not.toContain("password"); expect(fetch).not.toHaveBeenCalled();
});
it("manual and realtime pages cannot allocate a new key over pending account intent", () => {
  const first = prepare(), generate = vi.fn(() => next);
  expect(prepareBhCreateRequest(storage, 1, { ...payload, source: "replenish" }, undefined, generate)).toEqual(first);
  expect(generate).not.toHaveBeenCalled();
});
it("explicit repair keeps original key and source; stale clears cannot erase another request", () => {
  prepare(); expect(prepareBhCreateRequest(storage, 1, { ...payload, remark: "更正" }, key).requestKey).toBe(key);
  expect(() => prepareBhCreateRequest(storage, 1, { ...payload, source: "replenish" }, key)).toThrow("原创建入口");
  expect(clearBhCreateRequest(storage, 1, next)?.remark).toBe("更正");
  expect(clearBhCreateRequest(storage, 1, key)).toBeNull();
  expect(() => prepareBhCreateRequest(storage, 1, payload, key)).toThrow("已变化");
});
it.each(["{", "x".repeat(32001), JSON.stringify({ ...payload, requestKey: "bad" }), JSON.stringify({ ...payload, requestKey: key, lines: [] })])("damaged storage blocks replacement and remains intact", raw => {
  data.set(bhCreateStorageKey(1), raw); expect(() => prepare()).toThrow("损坏"); expect(data.get(bhCreateStorageKey(1))).toBe(raw);
});
it.each(["0", "0.0000", "1e3", "NaN", "1.12345", "10000000000"])("rejects invalid quantity %s before storage or HTTP", qty => {
  expect(() => prepareBhCreateRequest(storage, 1, { ...payload, lines: [{ skuId: 7, qty }] }, undefined, () => key)).toThrow();
  expect(data.size).toBe(0); expect(fetch).not.toHaveBeenCalled();
});
it("rejects 201 items instead of silently truncating them", () => {
  expect(() => prepareBhCreateRequest(storage, 1, { ...payload, lines: Array.from({ length: 201 }, () => payload.lines[0]) }, undefined, () => key)).toThrow();
  expect(data.size).toBe(0);
});
it("quota failure occurs before submission", () => {
  expect(() => prepareBhCreateRequest({ ...storage, setItem: () => { throw Error("quota"); } }, 1, payload, undefined, () => key)).toThrow("quota");
  expect(fetch).not.toHaveBeenCalled();
});
it("serializes allocation across tabs; unsupported browser cannot invoke writes", async () => {
  let tail = Promise.resolve(); const names: string[] = [];
  vi.stubGlobal("navigator", { locks: { request: (name: string, fn: () => Promise<unknown>) => {
    names.push(name); const run = tail.then(fn); tail = run.then(() => undefined); return run;
  } } });
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const first = withBhCreateLock(1, async () => { const r = prepare(); started.resolve(); await gate.promise; return r; });
  await started.promise;
  const second = withBhCreateLock(1, async () => prepareBhCreateRequest(storage, 1, payload, undefined, () => next));
  gate.resolve(); expect(await first).toEqual(await second); expect(names).toEqual([bhCreateStorageKey(1), bhCreateStorageKey(1)]);
  vi.stubGlobal("navigator", {}); const action = vi.fn();
  await expect(withBhCreateLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("creation validates POST then independently reads the current original document state", async () => {
  const request = prepare(); fetch.mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ...receipt, document: { ...document, status: "closed" } });
  expect((await submitBhCreateRequest(request)).document?.status).toBe("closed");
  expect(fetch.mock.calls[0][0]).toBe("/api/outsource/bh");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ requestKey: key, remark: payload.remark, lines: payload.lines });
  expect(fetch.mock.calls[1][1].cache).toBe("no-store"); expect(loadBhCreateRequest(storage, 1)).toEqual(request);
});
it("realtime uses its own endpoint and original exact items", async () => {
  const request = prepareBhCreateRequest(storage, 1, { source: "replenish", lines: [{ skuId: 7, qty: "12.3456" }] }, undefined, () => key);
  fetch.mockResolvedValue({ ...receipt, source: "replenish" }); await submitBhCreateRequest(request);
  expect(fetch.mock.calls[0][0]).toBe("/api/replenish/draft"); expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ requestKey: key, items: request.lines });
});
it("missing lookup is read-only and retains original request", async () => {
  const request = prepare(); fetch.mockResolvedValue({ requestKey: key, source: null, document: null });
  expect((await lookupBhCreateRequest(key)).document).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].method).toBeUndefined(); expect(loadBhCreateRequest(storage, 1)).toEqual(request);
});
it.each([{}, { ...receipt, requestKey: next }, { ...receipt, source: "replenish" }, { ...receipt, document: { ...document, docNo: "/evil" } }])("malformed or mismatched results never discard original intent", async response => {
  const request = prepare(); fetch.mockResolvedValue(response); await expect(submitBhCreateRequest(request)).rejects.toThrow(); expect(loadBhCreateRequest(storage, 1)).toEqual(request);
});
it("timeout retains intent; a later read can recover the committed original without auto POST", async () => {
  vi.useFakeTimers(); const request = prepare(), late = Promise.withResolvers<unknown>(); fetch.mockReturnValue(late.promise);
  const submit = submitBhCreateRequest(request, 20), assertion = expect(submit).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await assertion; expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  late.resolve(receipt); fetch.mockResolvedValue(receipt); expect((await lookupBhCreateRequest(key)).document).toEqual(document);
  expect(fetch).toHaveBeenCalledTimes(2); expect(loadBhCreateRequest(storage, 1)).toEqual(request);
});
