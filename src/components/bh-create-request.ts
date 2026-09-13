import { z } from "zod";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
const uuid = z.string().uuid().transform(s => s.toLowerCase());
const source = z.enum(["manual", "replenish"]);
const requestSchema = z.object({
  requestKey: uuid, source,
  remark: z.string().trim().max(500).optional().transform(s => s || undefined),
  orderType: z.string().max(80).optional(),
  lines: z.array(z.object({
    skuId: id, qty: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/).refine(s => /[1-9]/.test(s)),
    expectDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })).min(1).max(200),
});
export type BhCreateRequest = z.infer<typeof requestSchema>;
export type BhCreatePayload = Omit<BhCreateRequest, "requestKey">;
const resultSchema = z.object({ requestKey: uuid, source: source.nullable(), document: z.object({
  id, docNo: z.string().regex(/^BH-[A-Za-z0-9-]{1,100}$/), status: z.string().regex(/^[a-z_]{1,30}$/),
}).nullable() }).refine(r => r.document ? r.source !== null : r.source === null);
export type BhCreateResult = z.infer<typeof resultSchema>;
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const bhCreateStorageKey = (actorId: number) => `scm:bh-create:v1:${id.parse(actorId)}`;

export function loadBhCreateRequest(storage: RequestStorage, actorId: number): BhCreateRequest | null {
  const raw = storage.getItem(bhCreateStorageKey(actorId));
  if (raw == null) return null;
  try { if (raw.length > 32000) throw Error(); return requestSchema.parse(JSON.parse(raw)); }
  catch { throw Error("本机备货恢复记录损坏，请先核对已有备货申请；不要直接重复建单"); }
}
/** Hold account lock across both manual and replenishment pages. Preserve original line order. */
export function prepareBhCreateRequest(storage: RequestStorage, actorId: number, payload: BhCreatePayload,
  editKey?: string, createKey: () => string = () => crypto.randomUUID()): BhCreateRequest {
  const previous = loadBhCreateRequest(storage, actorId);
  if (previous && previous.requestKey !== editKey) return previous;
  if (editKey && !previous) throw Error("原恢复记录已变化，请刷新后核对");
  const request = requestSchema.parse({ ...payload, requestKey: previous?.requestKey ?? createKey() });
  if (previous && previous.source !== request.source) throw Error("请回到原创建入口修正请求，不要切换来源");
  storage.setItem(bhCreateStorageKey(actorId), JSON.stringify(request));
  return request;
}
export function clearBhCreateRequest(storage: RequestStorage, actorId: number, expectedKey: string) {
  const current = loadBhCreateRequest(storage, actorId);
  if (current?.requestKey !== expectedKey) return current;
  storage.removeItem(bhCreateStorageKey(actorId));
  return loadBhCreateRequest(storage, actorId);
}
export async function withBhCreateLock<T>(actorId: number, action: () => Promise<T>): Promise<T> {
  const key = bhCreateStorageKey(actorId);
  if (!navigator.locks?.request) throw Error("当前浏览器不支持安全创建恢复，请使用新版浏览器；尚未发送请求");
  return navigator.locks.request(key, action);
}
async function boundedRequest(url: string, init: RequestInit, key: string, timeoutMs: number): Promise<BhCreateResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("响应超时，已保留原请求；请先核对原单，不要重复建单")); controller.abort();
  }, timeoutMs); });
  try {
    const result = resultSchema.safeParse(await Promise.race([fetchJson<unknown>(url, { ...init, signal: controller.signal }), timeout]));
    if (!result.success || result.data.requestKey !== key) throw Error("结果格式异常，已保留原请求，请先核对");
    return result.data;
  } finally { clearTimeout(timer); }
}
export function lookupBhCreateRequest(requestKey: string, timeoutMs = 20_000) {
  const key = uuid.parse(requestKey);
  return boundedRequest(`/api/outsource/bh/create-result?requestKey=${encodeURIComponent(key)}`, { cache: "no-store" }, key, timeoutMs);
}
export async function submitBhCreateRequest(request: BhCreateRequest, timeoutMs = 20_000): Promise<BhCreateResult> {
  const r = requestSchema.parse(request), { source: origin, ...manual } = r;
  const result = await boundedRequest(origin === "manual" ? "/api/outsource/bh" : "/api/replenish/draft", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(origin === "manual" ? manual
      : { requestKey: r.requestKey, remark: r.remark, items: r.lines.map(l => ({ skuId: l.skuId, qty: l.qty })) }),
  }, r.requestKey, timeoutMs);
  if (!result.document || result.source !== origin) throw Error("尚未确认原备货申请，请继续核对");
  // Do not present a replayed, edited or closed document as a newly created draft.
  const current = await lookupBhCreateRequest(r.requestKey, timeoutMs);
  if (!current.document || current.document.id !== result.document.id || current.source !== origin) throw Error("原单状态尚未确认，请继续核对");
  return current;
}
