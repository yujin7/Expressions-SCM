import { z } from "zod";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
const requestSchema = z.object({ skuId: id, alertId: id, supplierId: id, workItemId: id, assigneeId: id,
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), candidateQty: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/),
  evidenceKey: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().uuid(), note: z.string().trim().min(5).max(1000),
}).strict();
export type CapacityRequest = z.infer<typeof requestSchema>;
export type CapacityPayload = Omit<CapacityRequest, "requestId">;
const resultSchema = z.object({ requestId: z.string().uuid(), itemId: id, eventId: id.nullable() });
export type CapacityResult = z.infer<typeof resultSchema>;
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const capacityStorageKey = (actorId: number) => `scm:capacity-handoff:v1:${id.parse(actorId)}`;
export function loadCapacityRequest(storage: RequestStorage, actorId: number): CapacityRequest | null {
  const raw = storage.getItem(capacityStorageKey(actorId));
  if (raw == null) return null;
  try { if (raw.length > 8000) throw Error(); return requestSchema.parse(JSON.parse(raw)); }
  catch { throw Error("本机产能恢复记录损坏，请人工核对待办历史；不要重新保存"); }
}
/** Caller must own the account Web Lock; correction keeps original item and request identity. */
export function prepareCapacityRequest(storage: RequestStorage, actorId: number, payload: CapacityPayload, editId?: string,
  createId: () => string = () => crypto.randomUUID()) {
  const prior = loadCapacityRequest(storage, actorId);
  if (prior && prior.requestId !== editId) throw Error("有原产能请求尚未核对，未发送新请求");
  if (editId && (!prior || prior.requestId !== editId)) throw Error("原请求已变化，请重新核对");
  const request = requestSchema.parse({ ...payload, requestId: prior?.requestId ?? createId() });
  if (prior && (prior.workItemId !== request.workItemId || prior.alertId !== request.alertId || prior.skuId !== request.skuId)) throw Error("修正须保留原SKU、告警与承接待办，请返回原来源核对");
  storage.setItem(capacityStorageKey(actorId), JSON.stringify(request));
  return request;
}
export function clearCapacityRequest(storage: RequestStorage, actorId: number, expectedId: string) {
  const prior = loadCapacityRequest(storage, actorId);
  if (prior?.requestId === expectedId) storage.removeItem(capacityStorageKey(actorId));
  return loadCapacityRequest(storage, actorId);
}
export async function withCapacityLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error("当前浏览器不支持安全保存恢复，请使用新版浏览器；尚未发送请求");
  return navigator.locks.request(capacityStorageKey(actorId), action);
}
async function bounded(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("响应超时，已保留原产能请求；请先核对，不要重复保存")); controller.abort();
  }, timeoutMs); });
  try { return await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}
export async function lookupCapacityRequest(request: CapacityRequest, timeoutMs = 20_000): Promise<CapacityResult> {
  const r = requestSchema.parse(request);
  const result = resultSchema.safeParse(await bounded(`/api/outsource/sourcing-aid?mode=capacity-result&workItemId=${r.workItemId}&requestId=${encodeURIComponent(r.requestId)}`, { cache: "no-store" }, timeoutMs));
  if (!result.success || result.data.requestId !== r.requestId || result.data.itemId !== r.workItemId) throw Error("原产能回执格式未确认，请继续核对");
  return result.data;
}
export async function submitCapacityRequest(request: CapacityRequest, timeoutMs = 20_000): Promise<CapacityResult> {
  const r = requestSchema.parse(request);
  const receipt = z.object({ itemId: id, eventId: id, replayed: z.boolean() }).safeParse(await bounded("/api/outsource/sourcing-aid", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r),
  }, timeoutMs));
  if (!receipt.success || receipt.data.itemId !== r.workItemId) throw Error("保存结果未确认，原请求已保留，请先核对");
  return { requestId: r.requestId, itemId: receipt.data.itemId, eventId: receipt.data.eventId };
}
