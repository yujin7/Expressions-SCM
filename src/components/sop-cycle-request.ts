import { z } from "zod";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
const uuid = z.string().uuid().transform(key => key.toLowerCase());
const intentSchema = z.object({
  month: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/),
  name: z.string().trim().min(2).max(100), planningVersionId: id,
});
const requestSchema = intentSchema.extend({ requestKey: uuid });
const cycleSchema = intentSchema.extend({ id, version: id, status: z.enum(["consensus", "frozen", "executing", "closed"]) });
const resultSchema = z.object({ requestKey: uuid, cycle: cycleSchema.nullable(),
  originalIntent: intentSchema.extend({ planDigest: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
}).refine(value => value.cycle !== null || value.originalIntent === null);
export type SopCycleRequest = z.infer<typeof requestSchema>;
export type SopCyclePayload = z.infer<typeof intentSchema>;
export type SopCycleResult = z.infer<typeof resultSchema>;
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const sopCycleStorageKey = (actorId: number) => `scm:sop-create:v1:${id.parse(actorId)}`;

export function loadSopCycleRequest(storage: RequestStorage, actorId: number): SopCycleRequest | null {
  const raw = storage.getItem(sopCycleStorageKey(actorId));
  if (raw === null) return null;
  try {
    if (raw.length > 2000) throw Error();
    return requestSchema.parse(JSON.parse(raw));
  } catch { throw Error("本机周期创建记录损坏，请先人工核对原周期；不要重新创建"); }
}

/** Account Web Lock required. No fresh key while an earlier request is unresolved. */
export function prepareSopCycleRequest(storage: RequestStorage, actorId: number, payload: SopCyclePayload,
  editKey?: string, createKey: () => string = () => crypto.randomUUID()) {
  const previous = loadSopCycleRequest(storage, actorId);
  if (previous && previous.requestKey !== editKey) return previous;
  if (editKey && !previous) throw Error("原周期创建记录已变化，请重新核对");
  const request = requestSchema.parse({ ...payload, requestKey: previous?.requestKey ?? createKey() });
  storage.setItem(sopCycleStorageKey(actorId), JSON.stringify(request));
  return request;
}

export function clearSopCycleRequest(storage: RequestStorage, actorId: number, expectedKey: string) {
  const current = loadSopCycleRequest(storage, actorId);
  if (current?.requestKey !== expectedKey) return current;
  storage.removeItem(sopCycleStorageKey(actorId));
  return loadSopCycleRequest(storage, actorId);
}

export async function withSopCycleLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error("当前浏览器不支持安全创建恢复，请使用新版浏览器；尚未发送请求");
  return navigator.locks.request(sopCycleStorageKey(actorId), action);
}

async function boundedRequest(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("响应超时，已保留原周期请求；请先核对结果，不要重新创建")); controller.abort();
  }, timeoutMs); });
  try { return await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}

export async function lookupSopCycleRequest(requestKey: string, timeoutMs = 20_000): Promise<SopCycleResult> {
  const key = uuid.parse(requestKey);
  const parsed = resultSchema.safeParse(await boundedRequest(`/api/replenish/sop?createRequestKey=${encodeURIComponent(key)}`, { cache: "no-store" }, timeoutMs));
  if (!parsed.success || parsed.data.requestKey !== key) throw Error("周期核对响应异常，原请求已保留，请重试核对");
  return parsed.data;
}

export async function submitSopCycleRequest(request: SopCycleRequest, timeoutMs = 20_000): Promise<SopCycleResult> {
  const { requestKey, ...intent } = requestSchema.parse(request);
  const receipt = z.object({ requestKey: uuid, cycle: cycleSchema }).safeParse(await boundedRequest("/api/replenish/sop", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", ...intent, idempotencyKey: requestKey }),
  }, timeoutMs));
  if (!receipt.success || receipt.data.requestKey !== requestKey) throw Error("创建结果响应异常，原请求已保留，请先核对周期");
  const result = await lookupSopCycleRequest(requestKey, timeoutMs);
  if (!result.cycle || result.cycle.id !== receipt.data.cycle.id) throw Error("尚未确认原周期，请继续核对，不要重新创建");
  return result;
}
