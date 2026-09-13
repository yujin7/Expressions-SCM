import { z } from "zod";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
const uuid = z.string().uuid().transform(s => s.toLowerCase());
const decimal = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d+(\.\d+)?$/));
const payloadSchema = z.object({
  poId: id, warehouseId: id, remark: z.string().max(500).optional(),
  lines: z.array(z.object({ poLineId: id, skuId: id, qty: decimal, batchId: id.nullable(), reason: z.string().max(200).optional() })).min(1),
});
const requestSchema = payloadSchema.extend({ requestKey: uuid });
export type CtCreateRequest = z.infer<typeof requestSchema>;
export type CtCreatePayload = z.input<typeof payloadSchema>;
const resultSchema = z.object({ requestKey: uuid, document: z.object({ id, docNo: z.string().regex(/^CT-[A-Za-z0-9-]{1,100}$/),
  status: z.enum(["draft", "pending", "approved", "in_progress", "completed", "closed", "void"]),
}).nullable() });
export type CtCreateResult = z.infer<typeof resultSchema>;
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const ctCreateStorageKey = (actorId: number) => `scm:ct-create:v1:${id.parse(actorId)}`;

export function loadCtCreateRequest(storage: RequestStorage, actorId: number): CtCreateRequest | null {
  const raw = storage.getItem(ctCreateStorageKey(actorId));
  if (raw == null) return null;
  try { if (raw.length > 100000) throw Error(); return requestSchema.parse(JSON.parse(raw)); }
  catch { throw Error("本机采购退货建单恢复记录损坏，请先核对已有采购退货单据；不要直接重复建单"); }
}
/** Caller holds the account browser lock. A pending request cannot be silently replaced. */
export function prepareCtCreateRequest(storage: RequestStorage, actorId: number, payload: CtCreatePayload,
  editKey?: string, createKey: () => string = () => crypto.randomUUID()): CtCreateRequest {
  const previous = loadCtCreateRequest(storage, actorId);
  if (previous && previous.requestKey !== editKey) return previous;
  if (editKey && !previous) throw Error("原恢复记录已变化，请刷新后核对");
  const request = requestSchema.parse({ ...payload, requestKey: previous?.requestKey ?? createKey() });
  const raw = JSON.stringify(request);
  if (raw.length > 100000) throw Error("请求明细过多，请拆分后再提交；尚未发送请求");
  storage.setItem(ctCreateStorageKey(actorId), raw);
  return request;
}
export function clearCtCreateRequest(storage: RequestStorage, actorId: number, expectedKey: string) {
  const current = loadCtCreateRequest(storage, actorId);
  if (current?.requestKey !== expectedKey) return current;
  storage.removeItem(ctCreateStorageKey(actorId));
  return loadCtCreateRequest(storage, actorId);
}
export async function withCtCreateLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error("当前浏览器不支持安全创建恢复，请使用新版浏览器；尚未发送请求");
  return navigator.locks.request(ctCreateStorageKey(actorId), action);
}
async function boundedRequest(url: string, init: RequestInit, key: string, timeoutMs: number): Promise<CtCreateResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("响应超时，已保留原请求；请核对原单或重试原请求，不要另建新单")); controller.abort();
  }, timeoutMs); });
  try {
    const result = resultSchema.safeParse(await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]));
    if (!result.success || result.data.requestKey !== key) throw Error("结果格式异常，原请求已保留，请先核对");
    return result.data;
  } finally { clearTimeout(timer); }
}
export function lookupCtCreateRequest(requestKey: string, timeoutMs = 20_000) {
  const key = uuid.parse(requestKey);
  return boundedRequest(`/api/matflow/ct/create-result?requestKey=${encodeURIComponent(key)}`, { cache: "no-store" }, key, timeoutMs);
}
export async function submitCtCreateRequest(request: CtCreateRequest, timeoutMs = 20_000) {
  const r = requestSchema.parse(request);
  const result = await boundedRequest("/api/matflow/ct", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) }, r.requestKey, timeoutMs);
  if (!result.document) throw Error("尚未确认原采购退货单，请继续核对");
  const current = await lookupCtCreateRequest(r.requestKey, timeoutMs);
  if (!current.document || current.document.id !== result.document.id) throw Error("原单状态尚未确认，请继续核对");
  return current;
}
