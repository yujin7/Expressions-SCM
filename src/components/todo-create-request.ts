import { z } from "zod";
import { fetchJson } from "./fetchJson";
const id = z.number().int().positive().max(2147483647);
const nullableText = (max: number) => z.string().trim().max(max).nullish().transform(v => v || null);
const intentSchema = z.object({ title: z.string().trim().min(1).max(200), detail: nullableText(2000), assigneeId: id,
  ownerRole: nullableText(40), priority: z.enum(["low", "normal", "high"]).default("normal"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().transform(v => v ?? null), sourceRef: nullableText(200),
}).strict();
const requestSchema = intentSchema.extend({ requestId: z.string().uuid().transform(s => s.toLowerCase()) });
const originalIntentSchema = z.unknown().refine(v => !!v && typeof v === "object" && Object.keys(intentSchema.shape).every(k => Object.hasOwn(v, k))).pipe(intentSchema);
export type TodoCreateIntent = z.input<typeof intentSchema>;
export type TodoCreateRequest = z.output<typeof requestSchema>;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const TODO_CREATE_CHANGED = "scm:todo-create:changed";
export const todoCreateKey = (actorId: number) => `scm:todo-create:v1:${id.parse(actorId)}`;
export function loadTodoCreate(storage: StorageLike, actorId: number): TodoCreateRequest | null {
  const raw = storage.getItem(todoCreateKey(actorId));
  if (raw === null) return null;
  try { if (raw.length > 12000) throw Error(); return requestSchema.parse(JSON.parse(raw)); }
  catch { throw Error("本机待办创建记录损坏，请人工核对；未发送新请求"); }
}
export function prepareTodoCreate(storage: StorageLike, actorId: number, input: TodoCreateIntent, editId?: string, createId = () => crypto.randomUUID()) {
  const prior = loadTodoCreate(storage, actorId);
  if (prior && prior.requestId !== editId) throw Error("原待办创建请求尚未核对，未发送新请求");
  if (editId && prior?.requestId !== editId) throw Error("原请求已变化，请重新核对");
  const request = requestSchema.parse({ ...input, requestId: prior?.requestId ?? createId() });
  storage.setItem(todoCreateKey(actorId), JSON.stringify(request)); return request;
}
export function clearTodoCreate(storage: StorageLike, actorId: number, requestId: string) {
  if (loadTodoCreate(storage, actorId)?.requestId === requestId) storage.removeItem(todoCreateKey(actorId));
}
export async function withTodoCreateLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error("浏览器不支持安全创建恢复，请使用新版浏览器；尚未发送请求");
  return navigator.locks.request(todoCreateKey(actorId), action);
}
async function bounded(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(Error("响应超时，原创建请求已保留，请先核对")); controller.abort(); }, timeoutMs); });
  try { return await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}
export async function lookupTodoCreate(input: TodoCreateRequest, timeoutMs = 20000) {
  const r = requestSchema.parse(input);
  const result = z.object({ requestId: z.string().uuid(), itemId: id.nullable(), originalIntent: originalIntentSchema.nullable() }).safeParse(
    await bounded(`/api/todo?mode=create-result&requestId=${r.requestId}`, { cache: "no-store" }, timeoutMs));
  if (!result.success || result.data.requestId !== r.requestId || (result.data.itemId === null) !== (result.data.originalIntent === null)) throw Error("原创建回执未确认，请继续核对；本机记录仍保留");
  return result.data;
}
export async function submitTodoCreate(input: TodoCreateRequest, timeoutMs = 20000) {
  const r = requestSchema.parse(input);
  const result = z.object({ requestId: z.string().uuid(), itemId: id, created: z.boolean() }).safeParse(await bounded("/api/todo", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r),
  }, timeoutMs));
  if (!result.success || result.data.requestId !== r.requestId) throw Error("未能确认创建结果，请先核对待办列表，勿重复提交");
  return result.data;
}
