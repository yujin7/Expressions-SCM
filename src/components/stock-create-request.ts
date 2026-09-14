import { z } from "zod";
import { TRANSFER_TYPES } from "@/lib/transfer-types";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
const uuid = z.string().uuid().transform(s => s.toLowerCase());
const decimal = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d+(\.\d+)?$/));
const payloadSchema = z.object({
  subtype: z.enum(["opening", "issue_out", "sales_out", "transfer"]), warehouseId: id,
  toWarehouseId: id.nullable().optional(), transferType: z.enum(TRANSFER_TYPES).optional(),
  reason: z.string().max(50).optional(), remark: z.string().max(500).optional(), riskDisposalId: id.optional(),
  lines: z.array(z.object({ skuId: id, qty: decimal, price: decimal.nullable().optional(), batchId: id.nullable().optional() })).min(1),
});
const requestSchema = payloadSchema.extend({ requestKey: uuid });
export type StockCreateRequest = z.infer<typeof requestSchema>;
export type StockCreatePayload = z.input<typeof payloadSchema>;
const resultSchema = z.object({ requestKey: uuid, document: z.object({ id, docNo: z.string().regex(/^(RK|CK|DB)-[A-Za-z0-9-]{1,100}$/),
  status: z.enum(["draft", "pending", "approved", "in_progress", "completed", "closed", "void"]),
}).nullable(), cancelled: z.literal(true).optional() }).refine(v => !v.cancelled || v.document === null);
export type StockCreateResult = z.infer<typeof resultSchema>;
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const stockCreateStorageKey = (actorId: number) => `scm:stock-create:v1:${id.parse(actorId)}`;

export function loadStockCreateRequest(storage: RequestStorage, actorId: number): StockCreateRequest | null {
  const raw = storage.getItem(stockCreateStorageKey(actorId));
  if (raw == null) return null;
  try { if (raw.length > 100000) throw Error(); return requestSchema.parse(JSON.parse(raw)); }
  catch { throw Error("本机库存建单恢复记录损坏，请先核对已有库存单据；不要直接重复建单"); }
}
/** Caller holds the account browser lock. A pending request cannot be silently replaced. */
export function prepareStockCreateRequest(storage: RequestStorage, actorId: number, payload: StockCreatePayload,
  editKey?: string, createKey: () => string = () => crypto.randomUUID()): StockCreateRequest {
  const previous = loadStockCreateRequest(storage, actorId);
  if (previous && previous.requestKey !== editKey) return previous;
  if (editKey && !previous) throw Error("原恢复记录已变化，请刷新后核对");
  const request = requestSchema.parse({ ...payload, requestKey: previous?.requestKey ?? createKey() });
  const raw = JSON.stringify(request);
  if (raw.length > 100000) throw Error("请求明细过多，请拆分后再提交；尚未发送请求");
  storage.setItem(stockCreateStorageKey(actorId), raw);
  return request;
}
export function clearStockCreateRequest(storage: RequestStorage, actorId: number, expectedKey: string) {
  const current = loadStockCreateRequest(storage, actorId);
  if (current?.requestKey !== expectedKey) return current;
  storage.removeItem(stockCreateStorageKey(actorId));
  return loadStockCreateRequest(storage, actorId);
}
export async function withStockCreateLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error("当前浏览器不支持安全创建恢复，请使用新版浏览器；尚未发送请求");
  return navigator.locks.request(stockCreateStorageKey(actorId), action);
}
async function boundedRequest(url: string, init: RequestInit, key: string, timeoutMs: number): Promise<StockCreateResult> {
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
export function lookupStockCreateRequest(requestKey: string, timeoutMs = 20_000) {
  const key = uuid.parse(requestKey);
  return boundedRequest(`/api/inventory/stock-doc/create-result?requestKey=${encodeURIComponent(key)}`, { cache: "no-store" }, key, timeoutMs);
}
export async function submitStockCreateRequest(request: StockCreateRequest, timeoutMs = 20_000) {
  const r = requestSchema.parse(request);
  const result = await boundedRequest("/api/inventory/stock-doc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) }, r.requestKey, timeoutMs);
  if (!result.document) throw Error("尚未确认原库存单，请继续核对");
  const current = await lookupStockCreateRequest(r.requestKey, timeoutMs);
  if (!current.document || current.document.id !== result.document.id) throw Error("原单状态尚未确认，请继续核对");
  return current;
}

/** Server-confirmed cancellation fences late submissions; local storage stays until acknowledgement. */
export async function cancelStockCreateRequest(requestKey: string, timeoutMs = 20_000) {
  const key = uuid.parse(requestKey);
  const first = await lookupStockCreateRequest(key, timeoutMs);
  if (first.document || first.cancelled) return first;
  const result = await boundedRequest("/api/inventory/stock-doc/cancel-create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: key }) }, key, timeoutMs);
  if (!result.cancelled && !result.document) throw Error("取消结果尚未确认，请保留原请求继续核对");
  const current = await lookupStockCreateRequest(key, timeoutMs);
  if (result.cancelled !== current.cancelled || result.document?.id !== current.document?.id) throw Error("取消结果尚未确认，请保留原请求继续核对");
  return current;
}
