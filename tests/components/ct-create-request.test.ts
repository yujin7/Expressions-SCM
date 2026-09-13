import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ctCreateStorageKey, clearCtCreateRequest, loadCtCreateRequest, lookupCtCreateRequest, prepareCtCreateRequest, submitCtCreateRequest, withCtCreateLock, type CtCreatePayload } from "@/components/ct-create-request";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ee392149-8738-4e50-992f-f565bba7f911", next = "ee392149-8738-4e50-992f-f565bba7f912";
const payload: CtCreatePayload = { poId: 8, warehouseId: 3, lines: [{ poLineId: 4, skuId: 7, qty: "3.0001", reason: "实物核对", batchId: 9 }, { poLineId: 4, skuId: 7, qty: "2", batchId: null }] };
const document = { id: 17, docNo: "CT-20260914-0001", status: "draft" };
const receipt = { requestKey: key, document };
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const prepare = () => prepareCtCreateRequest(storage, 1, payload, undefined, () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("preserves exact decimal, lot and independent line identity without storing unrelated secrets", () => {
  prepareCtCreateRequest(storage, 1, { ...payload, password: "never-store" } as CtCreatePayload, undefined, () => key.toUpperCase());
  expect(loadCtCreateRequest(storage, 1)).toEqual({ ...payload, requestKey: key });
  expect(loadCtCreateRequest(storage, 2)).toBeNull();
  expect([...data.values()].join()).not.toContain("password"); expect(fetch).not.toHaveBeenCalled();
});
it("all entry points share one unresolved account intent and cannot allocate another key", () => {
  const first = prepare(), generate = vi.fn(() => next);
  expect(prepareCtCreateRequest(storage, 1, { ...payload, poId: 9 }, undefined, generate)).toEqual(first);
  expect(generate).not.toHaveBeenCalled();
});
it("explicit repair keeps the key; stale editing and clears cannot erase a different request", () => {
  prepare(); expect(prepareCtCreateRequest(storage, 1, { ...payload, remark: "更正" }, key).requestKey).toBe(key);
  expect(clearCtCreateRequest(storage, 1, next)?.remark).toBe("更正");
  expect(clearCtCreateRequest(storage, 1, key)).toBeNull();
  expect(() => prepareCtCreateRequest(storage, 1, payload, key)).toThrow("已变化");
  const newer = prepareCtCreateRequest(storage, 1, payload, undefined, () => next);
  expect(clearCtCreateRequest(storage, 1, key)).toEqual(newer);
});
it.each(["{", "x".repeat(100001), JSON.stringify({ ...payload, requestKey: "bad" }), JSON.stringify({ ...payload, requestKey: key, lines: [] })])("damaged storage blocks replacement without deleting evidence", raw => {
  data.set(ctCreateStorageKey(1), raw); expect(() => prepare()).toThrow("损坏"); expect(data.get(ctCreateStorageKey(1))).toBe(raw);
});
it("quota failure occurs before submission", () => {
  expect(() => prepareCtCreateRequest({ ...storage, setItem: () => { throw Error("quota"); } }, 1, payload, undefined, () => key)).toThrow("quota");
  expect(fetch).not.toHaveBeenCalled();
});
it("serializes same-account cross-tab allocation; unsupported browsers cannot invoke writes", async () => {
  let tail = Promise.resolve(); const names: string[] = [];
  vi.stubGlobal("navigator", { locks: { request: (name: string, fn: () => Promise<unknown>) => {
    names.push(name); const run = tail.then(fn); tail = run.then(() => undefined); return run;
  } } });
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const first = withCtCreateLock(1, async () => { const r = prepare(); started.resolve(); await gate.promise; return r; });
  await started.promise;
  const second = withCtCreateLock(1, async () => prepareCtCreateRequest(storage, 1, payload, undefined, () => next));
  gate.resolve(); expect(await first).toEqual(await second); expect(names).toEqual([ctCreateStorageKey(1), ctCreateStorageKey(1)]);
  vi.stubGlobal("navigator", {}); const action = vi.fn();
  await expect(withCtCreateLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("creation validates POST then independently reads current state, not an assumed draft", async () => {
  const request = prepare(); fetch.mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ...receipt, document: { ...document, status: "void" } });
  expect((await submitCtCreateRequest(request)).document?.status).toBe("void");
  expect(fetch.mock.calls[0][0]).toBe("/api/matflow/ct");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
  expect(fetch.mock.calls[1][1].cache).toBe("no-store"); expect(loadCtCreateRequest(storage, 1)).toEqual(request);
});
it("not-found lookup is read-only and retains original request", async () => {
  const request = prepare(); fetch.mockResolvedValue({ requestKey: key, document: null });
  expect((await lookupCtCreateRequest(key)).document).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].method).toBeUndefined(); expect(loadCtCreateRequest(storage, 1)).toEqual(request);
});
it.each([{}, { ...receipt, requestKey: next }, { ...receipt, document: null }, { ...receipt, document: { ...document, docNo: "/evil" } }])("invalid results never discard original intent", async response => {
  const request = prepare(); fetch.mockResolvedValue(response); await expect(submitCtCreateRequest(request)).rejects.toThrow(); expect(loadCtCreateRequest(storage, 1)).toEqual(request);
});
it("a mismatched second read fails closed", async () => {
  const request = prepare(); fetch.mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ...receipt, document: { ...document, id: 18 } });
  await expect(submitCtCreateRequest(request)).rejects.toThrow("状态尚未确认"); expect(loadCtCreateRequest(storage, 1)).toEqual(request);
});
it("timeout retains intent; later read recovers a late commit without automatic POST", async () => {
  vi.useFakeTimers(); const request = prepare(), late = Promise.withResolvers<unknown>(); fetch.mockReturnValue(late.promise);
  const submit = submitCtCreateRequest(request, 20), assertion = expect(submit).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await assertion; expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  late.resolve(receipt); fetch.mockResolvedValue(receipt); expect((await lookupCtCreateRequest(key)).document).toEqual(document);
  expect(fetch).toHaveBeenCalledTimes(2); expect(loadCtCreateRequest(storage, 1)).toEqual(request);
});
it.each(["matflow/ct/ct-client.tsx"])("%s uses shared persistent recovery instead of direct unkeyed creation", path => {
  const source = readFileSync(`src/app/(app)/${path}`, "utf8");
  expect(source).toContain("useCtCreateRecovery"); expect(source).toContain("<CtCreateRecovery");
  expect(source).not.toMatch(/postJson[^\n]*["']\/api\/matflow\/ct["']/);
  expect(source).toContain("key={");
});
