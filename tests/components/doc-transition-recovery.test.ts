import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closingStorageKey, readClosingMarker, startClosingMarker, clearClosingMarker, postClosingAction, readClosingSnapshot } from "@/components/doc-transition-recovery";
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/components/fetchJson", () => ({ fetchJson: h.fetch }));
const token = "7d0821a7-b0d0-4b39-8cb5-9ab456fc47c2";
const key = closingStorageKey(1, "po", 3);
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
beforeEach(() => { data = new Map(); h.fetch.mockReset(); vi.stubGlobal("crypto", { randomUUID: () => token }); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("markers distinguish account, document type and ID, storing no business text", () => {
  expect(new Set([key, closingStorageKey(2, "po", 3), closingStorageKey(1, "wo", 3), closingStorageKey(1, "po", 4)]).size).toBe(4);
  const marker = startClosingMarker(storage, key, "short_close", 5);
  expect(marker).toEqual({ token, action: "short_close", version: 5 });
  expect(readClosingMarker(storage, key)).toEqual(marker);
  expect(() => closingStorageKey(0, "po", 3)).toThrow();
});
it("an outstanding marker is never silently replaced; acknowledgement only clears its exact token", () => {
  startClosingMarker(storage, key, "short_close", 5);
  expect(() => startClosingMarker(storage, key, "complete", 6)).toThrow("待核对");
  expect(clearClosingMarker(storage, key, "different")).toBe(false);
  expect(readClosingMarker(storage, key)).not.toBeNull();
  expect(clearClosingMarker(storage, key, token)).toBe(true);
  expect(readClosingMarker(storage, key)).toBeNull();
});
it.each(["{", "null", JSON.stringify({token, action:"void",version:1}), JSON.stringify({token,action:"complete",version:0}), "x".repeat(251)])("invalid marker fails closed: %s", raw => {
  data.set(key, raw); expect(() => readClosingMarker(storage, key)).toThrow(); expect(data.get(key)).toBe(raw);
});
it("storage quota error precedes any HTTP", () => {
  expect(() => startClosingMarker({ ...storage, setItem: () => { throw Error("quota"); } }, key, "complete", 1)).toThrow("quota");
  expect(h.fetch).not.toHaveBeenCalled();
});
it("POST preserves action/version/reason and validates its status response", async () => {
  h.fetch.mockResolvedValueOnce({status:"closed",idempotent:false});
  await postClosingAction("/api/outsource/po/3", "short_close", 5, "  不再补齐  ");
  expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toEqual({action:"short_close",version:5,reason:"不再补齐"});
  expect(h.fetch.mock.calls[0][0]).toBe("/api/outsource/po/3/transition");
  h.fetch.mockResolvedValueOnce({status:"in_progress",idempotent:false});
  await expect(postClosingAction("/api/outsource/po/3", "complete", 5, "")).rejects.toThrow("格式异常");
});
it("GET is uncached and rejects wrong document, version, or omitted reason field", async () => {
  const result={id:3,docNo:"PO-3",status:"closed",version:6,closedReason:"不再补齐"};
  h.fetch.mockResolvedValueOnce(result); expect(await readClosingSnapshot("/api/outsource/po/3","po",3)).toEqual(result);
  expect(h.fetch.mock.calls[0][1]).toMatchObject({cache:"no-store"}); expect(h.fetch.mock.calls[0][1].method).toBeUndefined();
  for(const bad of [{...result,id:4},{...result,docNo:"WO-3"},{...result,version:0},{...result,closedReason:undefined}]) {
    h.fetch.mockResolvedValueOnce(bad); await expect(readClosingSnapshot("/api/outsource/po/3","po",3)).rejects.toThrow("不完整");
  }
});
it("timeout aborts waiting without an automatic write retry", async () => {
  vi.useFakeTimers(); h.fetch.mockReturnValue(new Promise(() => {}));
  const pending=postClosingAction("/api/outsource/po/3","complete",5,"",30);
  const assertion=expect(pending).rejects.toThrow("响应超时"); await vi.advanceTimersByTimeAsync(30); await assertion;
  expect(h.fetch).toHaveBeenCalledTimes(1); expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true);
});
