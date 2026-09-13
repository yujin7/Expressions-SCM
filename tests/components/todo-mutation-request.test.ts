import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelTodoMutation, clearTodoMutation, loadTodoMutation, lookupTodoMutation, prepareTodoMutation, submitTodoMutation, todoMutationIsObsolete, todoMutationKey, withTodoMutationLock } from "@/components/todo-mutation-request";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/components/fetchJson", () => ({ fetchJson: fetch }));
const key = "bc264aa1-dac9-4929-93f5-c3dbce063329", next = "dc264aa1-dac9-4929-93f5-c3dbce063329";
const data = new Map<string, string>();
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
const row = { id: 7, title: "合成任务", version: 1 };
const prepare = () => prepareTodoMutation(storage, 1, row, { status: "done" }, () => key);
const current = { id: 7, title: row.title, version: 1, status: "open", assigneeId: 1, assigneeName: "合成人员", completedAt: null, suspicious: false };
const snapshot = { version: 2, status: "done", assigneeId: 1, completedAt: "2026-09-13T00:00:00.000Z", suspicious: false };
const receipt = { eventId: 17, requestId: key, originalIntent: { expectedVersion: 1, status: "done", assigneeId: null, note: null }, originalResult: snapshot };
const found = { itemId: 7, requestId: key, receipt, current: { ...current, ...snapshot } };
beforeEach(() => { data.clear(); fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("persists bounded original intent per actor and cannot overwrite pending operations", () => {
  const r = prepare(); expect(loadTodoMutation(storage, 1)).toEqual(r); expect(loadTodoMutation(storage, 2)).toBeNull();
  expect(() => prepareTodoMutation(storage, 1, { ...row, id: 8 }, { assigneeId: 2 }, () => next)).toThrow("尚未核对");
  clearTodoMutation(storage, 1, next); expect(loadTodoMutation(storage, 1)).toEqual(r);
  clearTodoMutation(storage, 1, key); expect(loadTodoMutation(storage, 1)).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it.each(["{", "x".repeat(6001), JSON.stringify({ requestId: key }), JSON.stringify({ ...row, itemId: 7, requestId: key, expectedVersion: 1, status: "done", assigneeId: null, note: null, credential: "unexpected" })])("corrupt storage fails closed and is never erased", raw => {
  data.set(todoMutationKey(1), raw); expect(() => prepare()).toThrow("损坏"); expect(data.get(todoMutationKey(1))).toBe(raw); expect(fetch).not.toHaveBeenCalled();
});
it("storage read/write failures stop the operation before network access", () => {
  expect(() => loadTodoMutation({ ...storage, getItem: () => { throw Error("privacy"); } }, 1)).toThrow("无法读取");
  expect(() => prepareTodoMutation({ ...storage, setItem: () => { throw Error("quota"); } }, 1, row, { status: "done" })).toThrow("未发送"); expect(fetch).not.toHaveBeenCalled();
});
it("cross-tab Web Lock serializes preparation; unsupported browsers do not invoke writes", async () => {
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_key: string, fn: () => Promise<void>) => { const next = tail.then(fn); tail = next.catch(() => {}); return next; } } });
  const first = withTodoMutationLock(1, async () => prepare()), second = withTodoMutationLock(1, async () => prepare());
  await expect(second).rejects.toThrow("尚未核对"); expect((await first).requestId).toBe(key);
  vi.stubGlobal("navigator", {}); const fn = vi.fn(); await expect(withTodoMutationLock(1, fn)).rejects.toThrow("尚未发送"); expect(fn).not.toHaveBeenCalled();
});
it("GET only recovers immutable receipt and current state independently; missing equal-version is not obsolete", async () => {
  const r = prepare();
  fetch.mockResolvedValueOnce({ ...found, receipt: null, current }).mockResolvedValueOnce({ ...found, current: { ...current, version: 3 } });
  const missing = await lookupTodoMutation(r); expect(missing.receipt).toBeNull(); expect(todoMutationIsObsolete(r, missing)).toBe(false);
  const recovered = await lookupTodoMutation(r); expect(recovered.receipt).toEqual(receipt); expect(recovered.current.status).toBe("open");
  expect(fetch.mock.calls.every(c => !c[1].method && c[1].cache === "no-store")).toBe(true); expect(loadTodoMutation(storage, 1)).toEqual(r);
});
it("only a missing receipt plus a strictly newer version proves an old operation cannot execute", async () => {
  const r = prepare(); fetch.mockResolvedValue({ ...found, receipt: null, current: { ...current, version: 3 } });
  expect(todoMutationIsObsolete(r, await lookupTodoMutation(r))).toBe(true);
  fetch.mockResolvedValue({ ...found, current: { ...current, version: 3 } }); expect(todoMutationIsObsolete(r, await lookupTodoMutation(r))).toBe(false);
});
it("explicit retry keeps original key/version/intent and never clears the pending record itself", async () => {
  const r = prepare(); fetch.mockResolvedValue({ ...found.current, mutationReceipt: receipt, replayed: true });
  expect((await submitTodoMutation(r)).receipt).toEqual(receipt);
  expect(fetch.mock.calls[0][0]).toBe("/api/todo/7"); expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ requestId: key, expectedVersion: 1, status: "done", note: null });
  expect(loadTodoMutation(storage, 1)).toEqual(r);
});
it.each([
  {}, { ...found, requestId: next }, { ...found, itemId: 8 }, { ...found, current: { ...current, id: 8 } },
  { ...found, receipt: { ...receipt, requestId: next } }, { ...found, receipt: { ...receipt, originalIntent: { ...receipt.originalIntent, note: "different" } } },
  { ...found, receipt: { ...receipt, originalResult: { ...snapshot, version: 3 } } },
  { ...found, current: { ...current, version: 2 } }, { ...found, current: { ...found.current, version: 1 } },
  { ...found, receipt: { ...receipt, originalResult: { ...snapshot, completedAt: null } } },
])("invalid/mismatched lookup never allows acknowledgement", async body => {
  const r = prepare(); fetch.mockResolvedValue(body); await expect(lookupTodoMutation(r)).rejects.toThrow("不一致"); expect(loadTodoMutation(storage, 1)).toEqual(r);
});
it.each([{}, { ...found.current, replayed: false }, { ...found.current, mutationReceipt: { ...receipt, requestId: next }, replayed: false }])("invalid mutation response keeps recovery instead of reporting success", async body => {
  const r = prepare(); fetch.mockResolvedValue(body); await expect(submitTodoMutation(r)).rejects.toThrow(); expect(loadTodoMutation(storage, 1)).toEqual(r);
});
it("timeout retains original record and does not automatically retry", async () => {
  vi.useFakeTimers(); const r = prepare(); fetch.mockReturnValue(new Promise(() => {}));
  const pending = submitTodoMutation(r, 20), assertion = expect(pending).rejects.toThrow("超时不代表服务端取消");
  await vi.advanceTimersByTimeAsync(21); await assertion; expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(loadTodoMutation(storage, 1)).toEqual(r);
});
const cancelled = { ...receipt, cancelled: true, originalResult: { version: 1, status: "open", assigneeId: 1, completedAt: null, suspicious: false } };
it("explicit cancellation posts the same original intent and validates a fence without clearing local evidence", async () => {
  const r = prepare(); fetch.mockResolvedValue({ ...found, receipt: cancelled, current });
  expect((await cancelTodoMutation(r)).receipt).toEqual(cancelled);
  expect(fetch.mock.calls[0][1].method).toBe("POST");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ mode: "cancel-mutation", requestId: key, ...receipt.originalIntent });
  expect(loadTodoMutation(storage, 1)).toEqual(r);
  expect((await lookupTodoMutation(r)).receipt?.cancelled).toBe(true);
});
it("save winning the cancellation race stays an applied receipt, not cancelled", async () => {
  const r = prepare(); fetch.mockResolvedValue(found); expect((await cancelTodoMutation(r)).receipt).toEqual(receipt);
});
it.each([{ ...cancelled, cancelled: false }, { ...cancelled, originalResult: snapshot }, { ...cancelled, originalIntent: { ...receipt.originalIntent, status: "open" } }])("invalid cancellation receipt cannot authorize local clearing", async bad => {
  const r = prepare(); fetch.mockResolvedValue({ ...found, receipt: bad, current });
  await expect(cancelTodoMutation(r)).rejects.toThrow("不一致"); expect(loadTodoMutation(storage, 1)).toEqual(r);
});
it("cancelled receipt cannot masquerade as a successful PATCH", async () => {
  const r = prepare(); fetch.mockResolvedValue({ ...current, mutationReceipt: cancelled, replayed: true });
  await expect(submitTodoMutation(r)).rejects.toThrow("先核对"); expect(loadTodoMutation(storage, 1)).toEqual(r);
});
it("lost cancellation response preserves the original record and later GET recovers the fence", async () => {
  vi.useFakeTimers(); const r = prepare(); fetch.mockReturnValueOnce(new Promise(() => {}));
  const pending = cancelTodoMutation(r, 20), assertion = expect(pending).rejects.toThrow("超时");
  await vi.advanceTimersByTimeAsync(21); await assertion; expect(loadTodoMutation(storage, 1)).toEqual(r);
  fetch.mockResolvedValue({ ...found, receipt: cancelled, current }); expect((await lookupTodoMutation(r)).receipt).toEqual(cancelled);
  expect(fetch).toHaveBeenCalledTimes(2);
});
