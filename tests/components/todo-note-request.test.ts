import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearTodoNote, loadTodoNote, lookupTodoNote, prepareTodoNote, submitTodoNote, todoNoteKey, withTodoNoteLock } from "@/components/todo-note-request";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8", next = "ec264aa1-38a0-4803-9643-f9371545d3b9";
let data: Map<string, string>;
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const prepare = () => prepareTodoNote(storage, 1, 7, "合成原跟进记录内容", () => key);
beforeEach(() => { data = new Map(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("persists normalized content per actor, prevents replacement and stale acknowledgement", () => {
  const r = prepare(); expect(loadTodoNote(storage, 1)).toEqual(r); expect(loadTodoNote(storage, 2)).toBeNull();
  const generator = vi.fn(() => next);
  expect(() => prepareTodoNote(storage, 1, 9, "不得另建新的记录", generator)).toThrow("尚未核对"); expect(generator).not.toHaveBeenCalled();
  clearTodoNote(storage, 1, next); expect(loadTodoNote(storage, 1)).toEqual(r);
  clearTodoNote(storage, 1, key); expect(loadTodoNote(storage, 1)).toBeNull();
});
it.each(["{", "x".repeat(8001), JSON.stringify({ itemId: 7, requestId: "bad", note: "合成跟进依据内容" }), JSON.stringify({ itemId: 7, requestId: key, note: "合成跟进依据内容", secret: "no" })])("damaged storage fails closed and is not erased", raw => {
  data.set(todoNoteKey(1), raw); expect(() => prepare()).toThrow("损坏"); expect(data.get(todoNoteKey(1))).toBe(raw); expect(fetch).not.toHaveBeenCalled();
});
it("storage quota prevents creation before any POST", () => {
  expect(() => prepareTodoNote({ ...storage, setItem: () => { throw Error("quota"); } }, 1, 7, "合成无存储的跟进")).toThrow("quota"); expect(fetch).not.toHaveBeenCalled();
});
it("cross-tab Web Lock serializes preparation and unsupported browser does not invoke action", async () => {
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_key: string, action: () => Promise<void>) => { const run = tail.then(action); tail = run.catch(() => {}); return run; } } });
  const one = withTodoNoteLock(1, async () => prepare()), two = withTodoNoteLock(1, async () => prepare());
  await expect(two).rejects.toThrow("尚未核对"); expect((await one).requestId).toBe(key);
  vi.stubGlobal("navigator", {}); const action = vi.fn(); await expect(withTodoNoteLock(1, action)).rejects.toThrow("尚未发送"); expect(action).not.toHaveBeenCalled();
});
it("GET returns exact original content; POST sends existing server contract and leaves acknowledgement to caller", async () => {
  const r = prepare(), result = { itemId: 7, requestId: key, eventId: 42, note: r.note };
  fetch.mockResolvedValueOnce({ ...result, eventId: null, note: null }).mockResolvedValueOnce(result).mockResolvedValueOnce({ eventId: 42, replayed: true });
  expect((await lookupTodoNote(r)).eventId).toBeNull(); expect(await lookupTodoNote(r)).toEqual(result);
  expect(fetch.mock.calls.every(c => c[1].method === undefined && c[1].cache === "no-store")).toBe(true);
  expect(await submitTodoNote(r)).toEqual({ eventId: 42, replayed: true });
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ requestId: key, note: r.note });
  expect(loadTodoNote(storage, 1)).toEqual(r);
});
it.each([{}, { itemId: 8, requestId: key, eventId: 42, note: "合成原跟进记录内容" }, { itemId: 7, requestId: next, eventId: 42, note: "合成原跟进记录内容" }, { itemId: 7, requestId: key, eventId: 42, note: "不同的原始记录内容" }, { itemId: 7, requestId: key, eventId: null, note: "不一致的空记录" }])("invalid lookup never clears recovery", async body => {
  const r = prepare(); fetch.mockResolvedValueOnce(body); await expect(lookupTodoNote(r)).rejects.toThrow("不一致"); expect(loadTodoNote(storage, 1)).toEqual(r);
});
it("a timeout does not imply cancellation, retry or loss of recovery", async () => {
  vi.useFakeTimers(); const r = prepare(); fetch.mockReturnValueOnce(new Promise(() => {}));
  const pending = submitTodoNote(r, 20), rejected = expect(pending).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(21); await rejected;
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(loadTodoNote(storage, 1)).toEqual(r);
});
