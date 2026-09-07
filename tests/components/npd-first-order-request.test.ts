import { beforeEach, expect, it, vi } from "vitest";
import { clearNpdFirstOrderRequest, loadNpdFirstOrderRequest, prepareNpdFirstOrderRequest, submitNpdFirstOrderRequest } from "@/components/npd-first-order-request";

const uuid = "ac264aa1-38a0-4803-9643-f9371545d3b8";
const nextUuid = "2ca9dd43-25e2-4e5c-93d1-456f0a1658e1";
let values: Map<string, string>;
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
beforeEach(() => { values = new Map(); });
it("persists the exact request across a component/browser restart", () => {
  const request = prepareNpdFirstOrderRequest(storage, 1, 8, 3, "12.5000", () => uuid);
  expect(loadNpdFirstOrderRequest(storage, 1, 8)).toEqual(request);
  const newKey = vi.fn(() => nextUuid);
  expect(prepareNpdFirstOrderRequest(storage, 1, 8, 10, "99", newKey)).toEqual(request);
  expect(newKey).not.toHaveBeenCalled();
});
it("isolates actor and project identities", () => {
  prepareNpdFirstOrderRequest(storage, 1, 8, 3, "12.5", () => uuid);
  expect(loadNpdFirstOrderRequest(storage, 2, 8)).toBeNull();
  expect(loadNpdFirstOrderRequest(storage, 1, 9)).toBeNull();
});
it("a late success cannot remove a newer request", () => {
  prepareNpdFirstOrderRequest(storage, 1, 8, 3, "12.5", () => uuid);
  expect(clearNpdFirstOrderRequest(storage, 1, 8, uuid)).toBeNull();
  prepareNpdFirstOrderRequest(storage, 1, 8, 4, "22", () => nextUuid);
  expect(clearNpdFirstOrderRequest(storage, 1, 8, uuid)?.requestKey).toBe(nextUuid);
  expect(loadNpdFirstOrderRequest(storage, 1, 8)?.requestKey).toBe(nextUuid);
});
it("a corrupted record is not silently discarded and replaced", () => {
  storage.setItem("scm:npd-first-order:v1:1:8", "bad JSON");
  expect(() => prepareNpdFirstOrderRequest(storage, 1, 8, 3, "12", () => uuid)).toThrow("损坏");
  expect(storage.getItem("scm:npd-first-order:v1:1:8")).toBe("bad JSON");
});
it.each(["0", "0.0000", "-1", "0.00001", "10000000000", "1e3", "NaN"])("rejects quantity %s before persisting", qty => {
  expect(() => prepareNpdFirstOrderRequest(storage, 1, 8, 3, qty, () => uuid)).toThrow();
  expect(values.size).toBe(0);
});
it("storage failure propagates so the caller cannot POST an unrecoverable request", () => {
  expect(() => prepareNpdFirstOrderRequest({ ...storage, setItem: () => { throw Error("quota"); } }, 1, 8, 3, "12", () => uuid)).toThrow("quota");
});
it("explicit local discard does not claim to cancel a server document", () => {
  prepareNpdFirstOrderRequest(storage, 1, 8, 3, "12", () => uuid);
  clearNpdFirstOrderRequest(storage, 1, 8);
  expect(loadNpdFirstOrderRequest(storage, 1, 8)).toBeNull();
});
it("a hanging write exits with an uncertain-result instruction, aborts and never retries", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetcher);
  try {
    const request = prepareNpdFirstOrderRequest(storage, 1, 8, 3, "12.5", () => uuid);
    const result = submitNpdFirstOrderRequest(request, 100);
    const assertion = expect(result).rejects.toThrow("已保留原请求");
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const options = (fetcher.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(options.signal?.aborted).toBe(true);
    expect(JSON.parse(options.body as string)).toEqual({ intent: "first_order", ...request });
    expect(loadNpdFirstOrderRequest(storage, 1, 8)).toEqual(request);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
it("a malformed success keeps recovery data and rejects before declaring a draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 0, docNo: "OTHER" }))));
  try {
    const request = prepareNpdFirstOrderRequest(storage, 1, 8, 3, "12.5", () => uuid);
    await expect(submitNpdFirstOrderRequest(request)).rejects.toThrow("结果格式异常");
    expect(loadNpdFirstOrderRequest(storage, 1, 8)).toEqual(request);
  } finally { vi.unstubAllGlobals(); }
});
it("a recovered result is returned without changing or automatically clearing the stored request", async () => {
  const result = { id: 12, docNo: "BH-20260907-0012", replayed: true };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(result))));
  try {
    const request = prepareNpdFirstOrderRequest(storage, 1, 8, 3, "12.5", () => uuid);
    expect(await submitNpdFirstOrderRequest(request)).toEqual(result);
    expect(loadNpdFirstOrderRequest(storage, 1, 8)).toEqual(request);
  } finally { vi.unstubAllGlobals(); }
});
