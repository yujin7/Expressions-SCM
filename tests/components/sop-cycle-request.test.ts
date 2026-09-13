import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSopCycleRequest, loadSopCycleRequest, lookupSopCycleRequest, prepareSopCycleRequest,
  submitSopCycleRequest, withSopCycleLock, type SopCyclePayload } from "@/components/sop-cycle-request";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8", nextKey = "ec264aa1-38a0-4803-9643-f9371545d3b9";
const payload: SopCyclePayload = { month: "2026-09", name: "数量计划", planningVersionId: 3 };
const cycle = { ...payload, id: 12, status: "closed", version: 2, planningVersionId: 4 };
const found = { requestKey: key, cycle, originalIntent: { ...payload, planDigest: "a".repeat(64) } };
const receipt = { requestKey: key, cycle };
const missing = { requestKey: key, cycle: null, originalIntent: null };
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const prepare = () => prepareSopCycleRequest(storage, 1, payload, undefined, () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("persists bounded whitelisted intent, canonical key and account isolation", () => {
  const saved = prepareSopCycleRequest(storage, 1, { ...payload, name: " 数量计划 ", password: "not-stored" } as SopCyclePayload, undefined, () => key.toUpperCase());
  expect(saved).toEqual({ ...payload, requestKey: key });
  expect(loadSopCycleRequest(storage, 1)).toEqual(saved);
  expect(loadSopCycleRequest(storage, 2)).toBeNull();
  expect([...data.values()].join()).not.toContain("password");
});
it("changed form cannot silently replace unresolved intent or generate another key", () => {
  const original = prepare(), generator = vi.fn(() => nextKey);
  expect(prepareSopCycleRequest(storage, 1, { ...payload, month: "2026-10", name: "不同计划", planningVersionId: 8 }, undefined, generator)).toEqual(original);
  expect(generator).not.toHaveBeenCalled();
});
it("explicit correction retains key; stale clear preserves newer request", () => {
  prepare(); expect(prepareSopCycleRequest(storage, 1, { ...payload, name: "修正原意" }, key).requestKey).toBe(key);
  expect(clearSopCycleRequest(storage, 1, nextKey)?.name).toBe("修正原意");
  expect(clearSopCycleRequest(storage, 1, key)).toBeNull();
  expect(() => prepareSopCycleRequest(storage, 1, payload, key)).toThrow("已变化");
  const next = prepareSopCycleRequest(storage, 1, payload, undefined, () => nextKey);
  expect(clearSopCycleRequest(storage, 1, key)).toEqual(next);
});
it.each(["{", "x".repeat(2001), JSON.stringify({ ...payload, requestKey: "bad" }), JSON.stringify({ ...payload, requestKey: key, month: "0000-09" }),
  JSON.stringify({ ...payload, requestKey: key, planningVersionId: 0 })])("corrupt record blocks new write without erasure", raw => {
  data.set("scm:sop-create:v1:1", raw); expect(() => prepare()).toThrow("记录损坏"); expect(data.get("scm:sop-create:v1:1")).toBe(raw);
});
it("storage quota failure stops before POST", () => {
  expect(() => prepareSopCycleRequest({ ...storage, setItem: () => { throw Error("quota"); } }, 1, payload)).toThrow("quota");
  expect(fetch).not.toHaveBeenCalled();
});
it("two tabs allocate one request; unsupported locks never invoke action", async () => {
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_name: string, action: () => Promise<void>) => { const run = tail.then(action); tail = run; return run; } } });
  const first = withSopCycleLock(1, async () => prepare());
  const second = withSopCycleLock(1, async () => prepareSopCycleRequest(storage, 1, { ...payload, month: "2026-10" }, undefined, () => nextKey));
  expect(await first).toEqual(await second);
  vi.stubGlobal("navigator", {}); const action = vi.fn();
  await expect(withSopCycleLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("POST followed by GET checks exact current cycle without assuming consensus or original plan", async () => {
  const original = prepare(); fetch.mockResolvedValueOnce(receipt).mockResolvedValueOnce(found);
  expect(await submitSopCycleRequest(original)).toEqual(found);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "create", ...payload, idempotencyKey: key });
  expect(fetch.mock.calls[1][0]).toContain("createRequestKey=");
  expect(fetch.mock.calls[1][1]).toMatchObject({ cache: "no-store" });
  expect(loadSopCycleRequest(storage, 1)).toEqual(original);
});
it("missing and legacy unknown-intent receipts stay distinct without writes", async () => {
  fetch.mockResolvedValueOnce(missing).mockResolvedValueOnce({ ...found, originalIntent: null });
  expect(await lookupSopCycleRequest(key)).toEqual(missing);
  expect((await lookupSopCycleRequest(key)).originalIntent).toBeNull();
  expect(fetch.mock.calls.every(c => c[1].method === undefined)).toBe(true);
});
it.each([{}, { ...found, requestKey: nextKey }, { ...found, cycle: { ...cycle, id: 0 } }, { ...found, cycle: { ...cycle, status: "banana" } }, { ...missing, originalIntent: found.originalIntent }])("invalid lookup leaves original request untouched", async value => {
  const original = prepare(); fetch.mockResolvedValue(value);
  await expect(lookupSopCycleRequest(key)).rejects.toThrow("响应异常"); expect(loadSopCycleRequest(storage, 1)).toEqual(original);
});
it("lost POST or lookup after commit keeps original key and payload", async () => {
  const original = prepare(); fetch.mockRejectedValueOnce(Error("lost"));
  await expect(submitSopCycleRequest(original)).rejects.toThrow("lost");
  fetch.mockResolvedValueOnce(receipt).mockRejectedValueOnce(Error("read failed"));
  await expect(submitSopCycleRequest(original)).rejects.toThrow("read failed");
  expect(loadSopCycleRequest(storage, 1)).toEqual(original);
});
it("mismatched cycle identity never confirms success", async () => {
  fetch.mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ...found, cycle: { ...cycle, id: 55 } });
  await expect(submitSopCycleRequest(prepare())).rejects.toThrow("尚未确认");
});
it("timeout is not cancellation; no automatic retry and late GET still recovers", async () => {
  vi.useFakeTimers(); const original = prepare(); fetch.mockReturnValueOnce(new Promise(() => {}));
  const result = submitSopCycleRequest(original, 20), assertion = expect(result).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await assertion;
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(loadSopCycleRequest(storage, 1)).toEqual(original);
  fetch.mockResolvedValueOnce(found); expect(await lookupSopCycleRequest(key)).toEqual(found);
});
