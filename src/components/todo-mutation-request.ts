import { z } from "zod";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
const status = z.enum(["open", "in_progress", "done", "cancelled"]);
const intentSchema = z.object({ expectedVersion: id, status: status.nullable(), assigneeId: id.nullable(), note: z.string().max(500).nullable() }).strict()
  .refine(v => v.status !== null || v.assigneeId !== null);
const requestSchema = z.object({ itemId: id, title: z.string().trim().min(1).max(200), requestId: z.string().uuid().transform(s => s.toLowerCase()),
  expectedVersion: id, status: status.nullable(), assigneeId: id.nullable(), note: z.string().trim().max(500).nullable(),
}).strict().refine(v => v.status !== null || v.assigneeId !== null);
const snapshotSchema = z.object({ version: id, status, assigneeId: id, completedAt: z.string().datetime().nullable(), suspicious: z.boolean() })
  .refine(v => (v.status === "done") === (v.completedAt !== null) && (!v.suspicious || v.status === "done"));
const currentSchema = z.object({ id, title: z.string().min(1).max(200), version: id, status, assigneeId: id,
  assigneeName: z.string().nullable(), completedAt: z.string().datetime().nullable(), suspicious: z.boolean() });
const receiptSchema = z.object({ eventId: id, requestId: z.string().uuid(), originalIntent: intentSchema, originalResult: snapshotSchema });
const resultSchema = z.object({ itemId: id, requestId: z.string().uuid(), receipt: receiptSchema.nullable(), current: currentSchema });
export type TodoMutationRequest = z.output<typeof requestSchema>;
export type TodoMutationLookup = z.output<typeof resultSchema>;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const TODO_MUTATION_CHANGED = "scm:todo-mutation:changed";
export const TODO_MUTATION_OPEN = "scm:todo-mutation:open";
export const todoMutationKey = (actorId: number) => `scm:todo-mutation:v1:${id.parse(actorId)}`;
export function loadTodoMutation(storage: StorageLike, actorId: number): TodoMutationRequest | null {
  let raw: string | null;
  try { raw = storage.getItem(todoMutationKey(actorId)); }
  catch { throw Error("本机操作恢复记录无法读取，请检查浏览器存储权限；未发送新操作"); }
  if (raw === null) return null;
  try { if (raw.length > 6000) throw Error(); return requestSchema.parse(JSON.parse(raw)); }
  catch { throw Error("本机待办操作恢复记录损坏，请人工核对；未发送新操作，也未清除原记录"); }
}
/** Called only under this actor's Web Lock. Never replace unresolved intent with a new click. */
export function prepareTodoMutation(storage: StorageLike, actorId: number, row: { id: number; title: string; version: number },
  patch: { status?: string; assigneeId?: number; note?: string | null }, createId = () => crypto.randomUUID()) {
  const prior = loadTodoMutation(storage, actorId);
  if (prior) throw Error(`待办 #${prior.itemId} 有原操作尚未核对，请使用页面顶部“恢复原操作”`);
  const request = requestSchema.parse({ itemId: row.id, title: row.title, expectedVersion: row.version, requestId: createId(),
    status: patch.status ?? null, assigneeId: patch.assigneeId ?? null, note: patch.note?.trim() || null });
  try { storage.setItem(todoMutationKey(actorId), JSON.stringify(request)); }
  catch { throw Error("本机无法保存恢复记录，本次操作未发送；请检查浏览器存储空间或权限"); }
  return request;
}
export function clearTodoMutation(storage: StorageLike, actorId: number, requestId: string) {
  if (loadTodoMutation(storage, actorId)?.requestId === requestId) storage.removeItem(todoMutationKey(actorId));
}
export async function withTodoMutationLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error("浏览器不支持安全操作恢复，请使用新版浏览器；尚未发送操作");
  return navigator.locks.request(todoMutationKey(actorId), action);
}
const originalIntent = (r: TodoMutationRequest) => ({ expectedVersion: r.expectedVersion, status: r.status, assigneeId: r.assigneeId, note: r.note });
function validateResult(raw: unknown, r: TodoMutationRequest): TodoMutationLookup {
  const parsed = resultSchema.safeParse(raw);
  const fail = () => { throw Error("原操作回执或当前任务不一致，请继续核对；本机记录仍保留"); };
  if (!parsed.success) return fail();
  const result = parsed.data, saved = result.receipt?.originalResult;
  if (result.itemId !== r.itemId || result.requestId !== r.requestId || result.current.id !== r.itemId || result.current.version < r.expectedVersion
    || !snapshotSchema.safeParse(result.current).success) return fail();
  if (result.receipt && (result.receipt.requestId !== r.requestId || JSON.stringify(result.receipt.originalIntent) !== JSON.stringify(originalIntent(r)))) return fail();
  if (saved && (saved.version < r.expectedVersion || saved.version > r.expectedVersion + 1 || result.current.version < saved.version
    || (r.status !== null && saved.status !== r.status) || (r.assigneeId !== null && saved.assigneeId !== r.assigneeId))) return fail();
  if (saved && result.current.version === saved.version && ["status", "assigneeId", "completedAt", "suspicious"].some(k => result.current[k as keyof typeof saved] !== saved[k as keyof typeof saved])) return fail();
  return result;
}
async function bounded(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(Error("响应超时，原操作已保留；超时不代表服务端取消，请先核对结果")); controller.abort(); }, timeoutMs); });
  try { return await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}
export async function lookupTodoMutation(input: TodoMutationRequest, timeoutMs = 20000) {
  const r = requestSchema.parse(input);
  return validateResult(await bounded(`/api/todo/${r.itemId}?mode=mutation-result&requestId=${r.requestId}`, { cache: "no-store" }, timeoutMs), r);
}
export async function submitTodoMutation(input: TodoMutationRequest, timeoutMs = 20000) {
  const r = requestSchema.parse(input);
  const raw = await bounded(`/api/todo/${r.itemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: r.requestId, expectedVersion: r.expectedVersion,
      ...(r.status === null ? {} : { status: r.status }), ...(r.assigneeId === null ? {} : { assigneeId: r.assigneeId }), note: r.note }),
  }, timeoutMs);
  const parsed = currentSchema.extend({ mutationReceipt: receiptSchema, replayed: z.boolean() }).safeParse(raw);
  if (!parsed.success) throw Error("保存回执格式未确认，原操作仍保留，请先核对");
  return validateResult({ itemId: r.itemId, requestId: r.requestId, receipt: parsed.data.mutationReceipt, current: parsed.data }, r);
}
/** Only a monotonically newer version proves this missing original request can no longer execute. */
export function todoMutationIsObsolete(request: TodoMutationRequest, result: TodoMutationLookup) {
  return result.receipt === null && result.current.version > request.expectedVersion;
}
