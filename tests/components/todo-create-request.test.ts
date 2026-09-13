import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearTodoCreate, loadTodoCreate, lookupTodoCreate, prepareTodoCreate, submitTodoCreate, todoCreateKey, withTodoCreateLock } from "@/components/todo-create-request";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8", next = "ec264aa1-38a0-4803-9643-f9371545d3b9";
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const intent = { title: "合成创建恢复", assigneeId: 7, priority: "normal" as const };
const prepare = () => prepareTodoCreate(storage, 1, intent, undefined, () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("isolates actors, preserves original key on explicit correction, refuses replacement and stale clear", () => {
  const r = prepare(); expect(loadTodoCreate(storage, 1)).toEqual(r); expect(loadTodoCreate(storage, 2)).toBeNull();
  const generator = vi.fn(() => next);
  expect(() => prepareTodoCreate(storage, 1, intent, undefined, generator)).toThrow("尚未核对"); expect(generator).not.toHaveBeenCalled();
  const corrected = prepareTodoCreate(storage, 1, { ...intent, title: "合成修正" }, key, generator);
  expect(corrected.requestId).toBe(key); expect(corrected.title).toBe("合成修正"); expect(generator).not.toHaveBeenCalled();
  clearTodoCreate(storage, 1, next); expect(loadTodoCreate(storage, 1)).toEqual(corrected);
  clearTodoCreate(storage, 1, key); expect(loadTodoCreate(storage, 1)).toBeNull();
  expect(() => prepareTodoCreate(storage, 1, intent, key, generator)).toThrow("已变化");
});
it.each(["{", "x".repeat(12001), JSON.stringify({ ...intent, requestId: "bad" }), JSON.stringify({ ...intent, requestId: key, secret: "no" })])("damaged storage is retained and prevents a new request", raw => {
  data.set(todoCreateKey(1), raw); expect(() => prepare()).toThrow("损坏"); expect(data.get(todoCreateKey(1))).toBe(raw); expect(fetch).not.toHaveBeenCalled();
});
it("quota failure stops before any POST", () => {
  expect(() => prepareTodoCreate({ ...storage, setItem: () => { throw Error("quota"); } }, 1, intent, undefined, () => key)).toThrow("quota"); expect(fetch).not.toHaveBeenCalled();
});
it("Web Lock serializes competing preparation and unsupported browser fails closed", async () => {
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_key: string, action: () => Promise<void>) => { const run = tail.then(action); tail = run.catch(() => {}); return run; } } });
  const one = withTodoCreateLock(1, async () => prepare()), two = withTodoCreateLock(1, async () => prepare());
  await expect(two).rejects.toThrow("尚未核对"); expect((await one).requestId).toBe(key);
  vi.stubGlobal("navigator", {}); const action = vi.fn(); await expect(withTodoCreateLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("lookup exposes immutable original intent, not later local corrections; explicit POST keeps the key", async () => {
  const r = prepare(); const { requestId: _key, ...originalIntent } = r;
  const result = { requestId: key, itemId: 42, originalIntent: { ...originalIntent, title: "真正原始标题" } };
  fetch.mockResolvedValueOnce({ requestId: key, itemId: null, originalIntent: null }).mockResolvedValueOnce(result).mockResolvedValueOnce({ requestId: key, itemId: 42, created: false });
  expect((await lookupTodoCreate(r)).itemId).toBeNull(); expect(await lookupTodoCreate(r)).toEqual(result);
  expect(fetch.mock.calls.every(c => c[1].method === undefined && c[1].cache === "no-store")).toBe(true);
  expect((await submitTodoCreate(r)).itemId).toBe(42); expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual(r);
  expect(loadTodoCreate(storage, 1)).toEqual(r);
});
it.each([{}, { requestId: next, itemId: null, originalIntent: null }, { requestId: key, itemId: 42, originalIntent: null }, { requestId: key, itemId: null, originalIntent: intent }, { requestId: key, itemId: 42, originalIntent: intent }])("malformed lookup cannot acknowledge or erase recovery", async body => {
  const r = prepare(); fetch.mockResolvedValueOnce(body); await expect(lookupTodoCreate(r)).rejects.toThrow("未确认"); expect(loadTodoCreate(storage, 1)).toEqual(r);
});
it.each([{}, { requestId: next, itemId: 42, created: true }, { requestId: key, itemId: 0, created: true }])("malformed POST result cannot acknowledge", async body => {
  const r = prepare(); fetch.mockResolvedValueOnce(body); await expect(submitTodoCreate(r)).rejects.toThrow("未能确认"); expect(loadTodoCreate(storage, 1)).toEqual(r);
});
it("timeout neither proves cancellation nor retries or erases the saved request", async () => {
  vi.useFakeTimers(); const r = prepare(); fetch.mockReturnValueOnce(new Promise(() => {}));
  const pending = submitTodoCreate(r, 20), rejected = expect(pending).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await rejected; expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(loadTodoCreate(storage, 1)).toEqual(r);
});
