import { z } from "zod";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
const uuid = z.string().uuid().transform(s => s.toLowerCase());
const requestSchema = z.object({
  requestKey: uuid, cycleId: id,
  skuIds: z.array(id).max(200).optional().transform(ids => ids?.length ? [...new Set(ids)].sort((a, b) => a - b) : undefined),
  includeSuppressed: z.boolean().default(false),
  remark: z.string().trim().max(500).optional().transform(s => s || undefined),
});
export type SopExecutionRequest = z.infer<typeof requestSchema>;
export type SopExecutionPayload = Omit<SopExecutionRequest, "requestKey">;
const resultSchema = z.object({
  requestKey: uuid,
  document: z.object({ id, docNo: z.string().regex(/^BH-[A-Za-z0-9-]{1,100}$/), status: z.string().regex(/^[a-z_]{1,30}$/) }).nullable(),
  requestIntent: z.object({ v: z.literal(1), cycleId: id, skuIds: z.array(id).max(200).nullable(), includeSuppressed: z.boolean(), remark: z.string().max(500).nullable() }).nullable(),
  lineCount: z.number().int().min(0).max(200),
}).refine(r => r.document ? r.requestIntent !== null && r.lineCount > 0 : r.requestIntent === null && r.lineCount === 0);
export type SopExecutionResult = z.infer<typeof resultSchema>;
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const sopRequestStorageKey = (actorId: number) => `scm:sop-execute:v1:${id.parse(actorId)}`;

/** Mirrors the existing WO recovery boundary: bounded intent, account scope, no credentials. */
export function loadSopExecutionRequest(storage: RequestStorage, actorId: number): SopExecutionRequest | null {
  const raw = storage.getItem(sopRequestStorageKey(actorId));
  if (raw == null) return null;
  try {
    if (raw.length > 5000) throw Error();
    return requestSchema.parse(JSON.parse(raw));
  } catch { throw Error("本机计划开单恢复记录损坏，请先核对原单；不要直接重复开单"); }
}

/** Hold the account lock. A new selection/cycle never overwrites an unresolved intent implicitly. */
export function prepareSopExecutionRequest(storage: RequestStorage, actorId: number, payload: SopExecutionPayload,
  editKey?: string, createKey: () => string = () => crypto.randomUUID()): SopExecutionRequest {
  const previous = loadSopExecutionRequest(storage, actorId);
  if (previous && previous.requestKey !== editKey) return previous;
  if (editKey && !previous) throw Error("恢复记录已变化，请重新核对");
  const request = requestSchema.parse({ ...payload, requestKey: previous?.requestKey ?? createKey() });
  storage.setItem(sopRequestStorageKey(actorId), JSON.stringify(request));
  return request;
}

/** Only acknowledge a server-confirmed receipt; stale tabs cannot erase a newer request. */
export function clearSopExecutionRequest(storage: RequestStorage, actorId: number, expectedKey: string) {
  const current = loadSopExecutionRequest(storage, actorId);
  if (current?.requestKey !== expectedKey) return current;
  storage.removeItem(sopRequestStorageKey(actorId));
  return loadSopExecutionRequest(storage, actorId);
}

export async function withSopExecutionLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  const key = sopRequestStorageKey(actorId);
  if (!navigator.locks?.request) throw Error("当前浏览器不支持安全开单恢复，请使用新版浏览器；尚未发送请求");
  return navigator.locks.request(key, action);
}

async function boundedRequest(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("响应超时，已保留原请求；请先核对结果，不要另开一单")); controller.abort();
  }, timeoutMs); });
  try { return await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}

export async function lookupSopExecutionRequest(requestKey: string, timeoutMs = 20_000): Promise<SopExecutionResult> {
  const key = uuid.parse(requestKey);
  const result = resultSchema.safeParse(await boundedRequest(`/api/replenish/sop?requestKey=${encodeURIComponent(key)}`, { cache: "no-store" }, timeoutMs));
  if (!result.success || result.data.requestKey !== key) throw Error("核对结果格式异常，已保留原请求，请重试核对");
  return result.data;
}

export async function submitSopExecutionRequest(request: SopExecutionRequest, timeoutMs = 20_000): Promise<SopExecutionResult> {
  const { requestKey, ...payload } = requestSchema.parse(request);
  const value = await boundedRequest("/api/replenish/sop", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "execute_draft", ...payload, idempotencyKey: requestKey }) }, timeoutMs);
  const receipt = z.object({ requestKey: uuid, draft: z.object({ id, docNo: z.string(), lineCount: z.number().int().positive() }) }).safeParse(value);
  if (!receipt.success || receipt.data.requestKey !== requestKey) throw Error("开单结果格式异常，已保留原请求，请先核对");
  // Read current document state instead of assuming a replay is still a draft.
  const result = await lookupSopExecutionRequest(requestKey, timeoutMs);
  if (!result.document || result.document.id !== receipt.data.draft.id || result.document.docNo !== receipt.data.draft.docNo
    || result.lineCount !== receipt.data.draft.lineCount) throw Error("尚未确认原备货申请，请继续核对，不要重复开单");
  return result;
}
