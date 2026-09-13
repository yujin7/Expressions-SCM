import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSopExecutionRequest, loadSopExecutionRequest, lookupSopExecutionRequest, prepareSopExecutionRequest,
  submitSopExecutionRequest, withSopExecutionLock, type SopExecutionPayload } from "@/components/sop-execution-request";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8", nextKey = "ec264aa1-38a0-4803-9643-f9371545d3b9";
const payload: SopExecutionPayload = { cycleId: 3, includeSuppressed: false };
const document = { id: 12, docNo: "BH-20260913-0012", status: "approved" };
const found = { requestKey: key, document, lineCount: 1, requestIntent: { v: 1, cycleId: 3, skuIds: null, includeSuppressed: false, remark: null } };
const receipt = { requestKey: key, draft: { id: 12, docNo: document.docNo, lineCount: 1 } };
const missing = { requestKey: key, document: null, lineCount: 0, requestIntent: null };
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const prepare = () => prepareSopExecutionRequest(storage, 1, payload, undefined, () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("restores only bounded normalized intent after refresh and isolates other accounts", () => {
  const saved = prepareSopExecutionRequest(storage, 1, { ...payload, skuIds: [3, 1, 3], remark: " 原请求 ", password: "never-store" } as SopExecutionPayload, undefined, () => key.toUpperCase());
  expect(saved).toEqual({ ...payload, skuIds: [1, 3], remark: "原请求", requestKey: key });
  expect(loadSopExecutionRequest(storage, 1)).toEqual(saved);
  expect(loadSopExecutionRequest(storage, 2)).toBeNull();
  expect([...data.values()].join()).not.toContain("password");
});
it("cycle/selection/suppression changes cannot replace an unresolved request", () => {
  const saved = prepare(), generate = vi.fn(() => nextKey);
  expect(prepareSopExecutionRequest(storage, 1, { cycleId: 99, skuIds: [5], includeSuppressed: true }, undefined, generate)).toEqual(saved);
  expect(generate).not.toHaveBeenCalled();
});
it("explicit correction retains the key, and stale acknowledgments preserve a newer intent", () => {
  prepare();
  expect(prepareSopExecutionRequest(storage, 1, { ...payload, skuIds: [2] }, key).requestKey).toBe(key);
  expect(clearSopExecutionRequest(storage, 1, nextKey)?.skuIds).toEqual([2]);
  expect(clearSopExecutionRequest(storage, 1, key)).toBeNull();
  expect(() => prepareSopExecutionRequest(storage, 1, payload, key)).toThrow("已变化");
  const second = prepareSopExecutionRequest(storage, 1, payload, undefined, () => nextKey);
  expect(clearSopExecutionRequest(storage, 1, key)).toEqual(second);
});
it.each(["{", "x".repeat(5001), JSON.stringify({ ...payload, requestKey: "bad" }), JSON.stringify({ ...payload, requestKey: key, cycleId: 0 }),
  JSON.stringify({ ...payload, requestKey: key, skuIds: Array(201).fill(1) })])("corrupt recovery data blocks replacement without erasing it", raw => {
  data.set("scm:sop-execute:v1:1", raw); expect(() => prepare()).toThrow("恢复记录"); expect(data.get("scm:sop-execute:v1:1")).toBe(raw);
});
it("storage failure stops before POST", () => {
  expect(() => prepareSopExecutionRequest({ ...storage, setItem: () => { throw Error("quota"); } }, 1, payload)).toThrow("quota");
  expect(fetch).not.toHaveBeenCalled();
});
it("cross-tab locks allocate one request, and unsupported browsers cannot submit", async () => {
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_name: string, action: () => Promise<void>) => { const run = tail.then(action); tail = run; return run; } } });
  const first = withSopExecutionLock(1, async () => prepare());
  const second = withSopExecutionLock(1, async () => prepareSopExecutionRequest(storage, 1, { ...payload, cycleId: 4 }, undefined, () => nextKey));
  expect(await first).toEqual(await second);
  vi.stubGlobal("navigator", {}); const action = vi.fn();
  await expect(withSopExecutionLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("POST is followed by read-only lookup of current state; success does not clear recovery", async () => {
  const request = prepare(); fetch.mockResolvedValueOnce(receipt).mockResolvedValueOnce(found);
  expect(await submitSopExecutionRequest(request)).toEqual(found);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "execute_draft", ...payload, idempotencyKey: key });
  expect(fetch.mock.calls[1][1].cache).toBe("no-store"); expect(fetch.mock.calls[1][1].method).toBeUndefined();
  expect(loadSopExecutionRequest(storage, 1)).toEqual(request);
});
it("lookup is read-only for both a missing result and a late-committed original intent", async () => {
  const original = prepare(); fetch.mockResolvedValueOnce(missing).mockResolvedValueOnce(found);
  expect(await lookupSopExecutionRequest(key)).toEqual(missing);
  expect(await lookupSopExecutionRequest(key)).toEqual(found);
  expect(fetch.mock.calls.every(c => c[1].method === undefined)).toBe(true);
  expect(loadSopExecutionRequest(storage, 1)).toEqual(original);
});
it.each([{}, { ...found, requestKey: nextKey }, { ...found, document: { ...document, id: 0 } }, { ...found, requestIntent: null }, { ...missing, lineCount: 1 }])("invalid lookup response retains original request", async value => {
  const original = prepare(); fetch.mockResolvedValue(value);
  await expect(lookupSopExecutionRequest(key)).rejects.toThrow("格式异常"); expect(loadSopExecutionRequest(storage, 1)).toEqual(original);
});
it("lost POST response and lookup failure after a committed POST both retain the same key", async () => {
  const original = prepare(); fetch.mockRejectedValueOnce(Error("connection lost"));
  await expect(submitSopExecutionRequest(original)).rejects.toThrow("connection lost");
  fetch.mockResolvedValueOnce(receipt).mockRejectedValueOnce(Error("lookup failed"));
  await expect(submitSopExecutionRequest(original)).rejects.toThrow("lookup failed");
  expect(loadSopExecutionRequest(storage, 1)).toEqual(original);
});
it("timeout ends waiting without automatic retry or removing recoverable intent", async () => {
  vi.useFakeTimers(); const original = prepare(); fetch.mockReturnValue(new Promise(() => {}));
  const result = submitSopExecutionRequest(original, 20); const assertion = expect(result).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await assertion;
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(loadSopExecutionRequest(storage, 1)).toEqual(original);
});
