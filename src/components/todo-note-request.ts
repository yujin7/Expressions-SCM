import { z } from "zod";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
const schema = z.object({ itemId: id, requestId: z.string().uuid(), note: z.string().trim().min(5).max(1000) }).strict();
export type TodoNoteRequest = z.infer<typeof schema>;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const TODO_NOTE_CHANGED = "scm:todo-note:changed";
export const todoNoteKey = (actorId: number) => `scm:todo-note:v1:${id.parse(actorId)}`;
export function loadTodoNote(storage: StorageLike, actorId: number): TodoNoteRequest | null {
  const raw = storage.getItem(todoNoteKey(actorId));
  if (raw === null) return null;
  try { if (raw.length > 8000) throw Error(); return schema.parse(JSON.parse(raw)); }
  catch { throw Error("本机跟进恢复记录损坏，请联系管理员核对历史；未发送新请求"); }
}
/** All prepare/clear calls must hold this account's Web Lock. */
export function prepareTodoNote(storage: StorageLike, actorId: number, itemId: number, note: string, createId = () => crypto.randomUUID()) {
  if (loadTodoNote(storage, actorId)) throw Error("有原跟进请求尚未核对，请先恢复原请求");
  const request = schema.parse({ itemId, note, requestId: createId() });
  storage.setItem(todoNoteKey(actorId), JSON.stringify(request));
  return request;
}
export function clearTodoNote(storage: StorageLike, actorId: number, requestId: string) {
  if (loadTodoNote(storage, actorId)?.requestId === requestId) storage.removeItem(todoNoteKey(actorId));
}
export async function withTodoNoteLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error("当前浏览器不支持安全恢复，请使用新版浏览器；尚未发送请求");
  return navigator.locks.request(todoNoteKey(actorId), action);
}
async function bounded(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("响应超时，原跟进请求已保留；请先核对结果")); controller.abort();
  }, timeoutMs); });
  try { return await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}
export async function lookupTodoNote(input: TodoNoteRequest, timeoutMs = 20_000) {
  const r = schema.parse(input);
  const result = z.object({ itemId: id, requestId: z.string().uuid(), eventId: id.nullable(), note: z.string().nullable() }).safeParse(
    await bounded(`/api/todo/${r.itemId}/history?mode=result&requestId=${encodeURIComponent(r.requestId)}`, { cache: "no-store" }, timeoutMs));
  if (!result.success || result.data.itemId !== r.itemId || result.data.requestId !== r.requestId
    || (result.data.eventId === null ? result.data.note !== null : result.data.note !== r.note)) throw Error("原跟进回执或内容不一致，请核对历史；本机请求仍保留");
  return result.data;
}
export async function submitTodoNote(input: TodoNoteRequest, timeoutMs = 20_000) {
  const r = schema.parse(input);
  const result = z.object({ eventId: id, replayed: z.boolean() }).safeParse(await bounded(`/api/todo/${r.itemId}/history`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: r.requestId, note: r.note }),
  }, timeoutMs));
  if (!result.success) throw Error("保存回执格式未确认，原跟进请求仍保留");
  return result.data;
}
