import { fetchJson } from "./fetchJson";

export type ClosingAction = "complete" | "short_close";
export interface ClosingMarker { token: string; action: ClosingAction; version: number }
export interface ClosingSnapshot { id: number; docNo: string; status: string; version: number; closedReason: string | null }
type StorageApi = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const positiveId = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(["draft", "pending", "approved", "in_progress", "completed", "closed", "void"]);

/** Reconciliation marker only: never a success receipt, password, fee or free-text reason. */
export function closingStorageKey(actorId: number, docType: "po" | "wo", docId: number) {
  if (!positiveId(actorId) || !positiveId(docId)) throw Error("请先核对登录账号与单据编号");
  return `scm:closing:v1:${actorId}:${docType}:${docId}`;
}
export function readClosingMarker(storage: StorageApi, key: string): ClosingMarker | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let marker: Partial<ClosingMarker>;
  try { if (raw.length > 250) throw Error(); marker = JSON.parse(raw); }
  catch { throw Error("本机收口核对记录损坏，请先核对单据及审计；尚未发送新操作"); }
  if (!marker || typeof marker.token !== "string" || !uuid.test(marker.token) || !positiveId(marker.version)
    || (marker.action !== "complete" && marker.action !== "short_close")) {
    throw Error("本机收口核对记录无效，请先核对单据及审计；尚未发送新操作");
  }
  return { token: marker.token!, action: marker.action, version: marker.version };
}
export function startClosingMarker(storage: StorageApi, key: string, action: ClosingAction, version: number): ClosingMarker {
  if (readClosingMarker(storage, key)) throw Error("该单据仍有待核对收口操作，请先核对当前状态");
  if (!positiveId(version)) throw Error("单据版本无效，请刷新核对");
  const marker = { token: crypto.randomUUID(), action, version };
  storage.setItem(key, JSON.stringify(marker));
  return marker;
}
export function clearClosingMarker(storage: StorageApi, key: string, token: string): boolean {
  if (readClosingMarker(storage, key)?.token !== token) return false;
  storage.removeItem(key);
  return true;
}
async function boundedRequest(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("响应超时，请先核对单据当前状态；不要重复收口")); controller.abort();
  }, timeoutMs); });
  try { return await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}
export async function postClosingAction(base: string, action: ClosingAction, version: number, reason: string, timeoutMs = 20_000) {
  const r = await boundedRequest(`${base}/transition`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version, ...(action === "short_close" ? { reason: reason.trim() } : {}) }) }, timeoutMs) as { status?: string; idempotent?: boolean } | null;
  if (!r || r.status !== (action === "complete" ? "completed" : "closed") || typeof r.idempotent !== "boolean") {
    throw Error("收口响应格式异常，请先核对单据，不要重复提交");
  }
  return r;
}
export async function readClosingSnapshot(base: string, docType: "po" | "wo", id: number, timeoutMs = 15_000): Promise<ClosingSnapshot> {
  const r = await boundedRequest(base, { cache: "no-store" }, timeoutMs) as Partial<ClosingSnapshot> | null;
  if (!r || r.id !== id || !positiveId(r.version) || typeof r.docNo !== "string"
    || !r.docNo.startsWith(`${docType.toUpperCase()}-`) || r.docNo.length > 120 || !statuses.has(r.status ?? "")
    || (r.closedReason !== null && typeof r.closedReason !== "string")) {
    throw Error("单据核对结果不完整或身份不一致，请重试读取");
  }
  return { id, docNo: r.docNo, status: r.status!, version: r.version, closedReason: r.closedReason! };
}
