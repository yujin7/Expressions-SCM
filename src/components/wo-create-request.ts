import { fetchJson } from "./fetchJson";

export interface WoCreatePayload {
  bhId?: number;
  productSkuId: number;
  qty: string;
  supplierId: number;
  feeRatePlan: string;
  dueDate?: string;
  orderType?: string;
  remark?: string;
}
export interface WoCreateRequest extends WoCreatePayload { requestKey: string }
export interface WoCreateResult { requestKey: string; document: { id: number; docNo: string; status: string } | null }
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const keyFor = (actorId: number) => `scm:wo-create:v1:${actorId}`;
const uuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const id = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 2147483647;
const decimal = (v: unknown, digits: number, scale: number): v is string => typeof v === "string" && new RegExp(`^\\d{1,${digits}}(\\.\\d{1,${scale}})?$`).test(v) && /[1-9]/.test(v);

/** Small account-scoped recovery draft, never credentials. Server validation remains authoritative. */
function parseRequest(value: unknown): WoCreateRequest {
  const r = value as Partial<WoCreateRequest> | null;
  if (!r || typeof r !== "object" || !uuid(r.requestKey) || !id(r.productSkuId) || !id(r.supplierId)
    || !decimal(r.qty, 10, 4) || !decimal(r.feeRatePlan, 12, 2) || (r.bhId != null && !id(r.bhId))
    || (r.dueDate != null && (typeof r.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.dueDate)))
    || (r.orderType != null && (typeof r.orderType !== "string" || r.orderType.length > 80))
    || (r.remark != null && (typeof r.remark !== "string" || r.remark.length > 500))) {
    throw Error("本机工单恢复记录无效，请先核对已有工单；不要直接重复建单");
  }
  return { requestKey: r.requestKey.toLowerCase(), productSkuId: r.productSkuId, supplierId: r.supplierId, qty: r.qty, feeRatePlan: r.feeRatePlan,
    ...(r.bhId != null ? { bhId: r.bhId } : {}), ...(r.dueDate ? { dueDate: r.dueDate } : {}),
    ...(r.orderType ? { orderType: r.orderType } : {}), ...(r.remark ? { remark: r.remark } : {}) };
}
export function loadWoCreateRequest(storage: RequestStorage, actorId: number): WoCreateRequest | null {
  if (!id(actorId)) throw Error("请先确认当前登录账号");
  const raw = storage.getItem(keyFor(actorId));
  if (raw == null) return null;
  if (raw.length > 5000) throw Error("本机工单恢复记录异常，请先核对已有工单");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw Error("本机工单恢复记录损坏，请先核对已有工单"); }
  return parseRequest(parsed);
}

/** Caller holds the browser account lock; uncertain intent is never silently replaced. */
export function prepareWoCreateRequest(storage: RequestStorage, actorId: number, payload: WoCreatePayload,
  editKey?: string, createKey: () => string = () => crypto.randomUUID()): WoCreateRequest {
  const previous = loadWoCreateRequest(storage, actorId);
  if (previous && previous.requestKey !== editKey) return previous;
  if (editKey && !previous) throw Error("恢复记录已变化，请刷新后核对，不要另发请求");
  const request = parseRequest({ ...payload, requestKey: previous?.requestKey ?? createKey() });
  storage.setItem(keyFor(actorId), JSON.stringify(request)); // Failure stops before POST.
  return request;
}
export function clearWoCreateRequest(storage: RequestStorage, actorId: number, expectedKey: string): WoCreateRequest | null {
  const current = loadWoCreateRequest(storage, actorId);
  if (current?.requestKey !== expectedKey) return current;
  storage.removeItem(keyFor(actorId));
  return loadWoCreateRequest(storage, actorId);
}
/** Cross-tab serialization prevents two tabs from allocating different keys for one unfinished intent. */
export async function withWoCreateLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  if (!id(actorId) || !navigator.locks?.request) throw Error("当前浏览器不支持安全创建恢复，请使用新版浏览器；尚未发送创建请求");
  return navigator.locks.request(keyFor(actorId), action);
}
function readResult(value: unknown, requestKey: string, allowMissing: boolean): WoCreateResult {
  const r = value as Partial<WoCreateResult> | null;
  if (!r || r.requestKey !== requestKey || (r.document === null && !allowMissing)
    || (r.document !== null && (!r.document || !id(r.document.id) || typeof r.document.docNo !== "string"
      || !/^WO-[A-Za-z0-9-]{1,100}$/.test(r.document.docNo) || typeof r.document.status !== "string" || !/^[a-z_]{1,30}$/.test(r.document.status)))) {
    throw Error("创建结果格式异常，已保留原请求，请先核对结果");
  }
  return r as WoCreateResult;
}
async function requestWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("核对或创建响应超时，已保留原请求；请核对结果或重试原请求，不要重复建单")); controller.abort();
  }, timeoutMs); });
  try { return await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}
export async function submitWoCreateRequest(request: WoCreateRequest, timeoutMs = 20_000): Promise<WoCreateResult> {
  return readResult(await requestWithTimeout("/api/outsource/wo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }, timeoutMs), request.requestKey, false);
}
export async function lookupWoCreateRequest(requestKey: string, timeoutMs = 20_000): Promise<WoCreateResult> {
  if (!uuid(requestKey)) throw Error("创建请求编号无效");
  return readResult(await requestWithTimeout(`/api/outsource/wo/create-result?requestKey=${encodeURIComponent(requestKey)}`, { cache: "no-store" }, timeoutMs), requestKey, true);
}
