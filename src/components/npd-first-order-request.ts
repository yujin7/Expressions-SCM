import { fetchJson } from "./fetchJson";

/** Browser recovery data only; the database receipt and project version enforce correctness. */
export interface NpdFirstOrderRequest {
  projectId: number;
  version: number;
  qty: string;
  requestKey: string;
}

type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const keyFor = (actorId: number, projectId: number) => `scm:npd-first-order:v1:${actorId}:${projectId}`;
const validQty = (qty: unknown): qty is string => typeof qty === "string" && /^\d{1,10}(\.\d{1,4})?$/.test(qty) && /[1-9]/.test(qty);
const positiveId = (id: unknown): id is number => typeof id === "number" && Number.isInteger(id) && id > 0 && id <= 2_147_483_647;

export function loadNpdFirstOrderRequest(storage: RequestStorage, actorId: number, projectId: number): NpdFirstOrderRequest | null {
  const raw = storage.getItem(keyFor(actorId, projectId));
  if (raw == null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw Error("本机首单请求记录损坏，请先核对已有草稿，再清除本机重试记录"); }
  if (!value || typeof value !== "object") throw Error("本机首单请求记录无效，请先核对已有草稿");
  const request = value as Partial<NpdFirstOrderRequest>;
  if (request.projectId !== projectId || !positiveId(request.version) || !validQty(request.qty)
    || typeof request.requestKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.requestKey)) {
    throw Error("本机首单请求记录无效，请先核对已有草稿，再清除本机重试记录");
  }
  return { projectId, version: request.version, qty: request.qty, requestKey: request.requestKey };
}

export function prepareNpdFirstOrderRequest(storage: RequestStorage, actorId: number, projectId: number, version: number, qty: string,
  createKey: () => string = () => crypto.randomUUID()): NpdFirstOrderRequest {
  const existing = loadNpdFirstOrderRequest(storage, actorId, projectId);
  if (existing) return existing; // An uncertain request is never silently replaced by a new quantity/version.
  if (!positiveId(actorId) || !positiveId(projectId) || !positiveId(version) || !validQty(qty)) throw Error("请填写大于0、最多10位整数及4位小数的数量，并核对项目版本");
  const request = { projectId, version, qty, requestKey: createKey() };
  storage.setItem(keyFor(actorId, projectId), JSON.stringify(request)); // Storage failure stops before POST.
  return request;
}

export function clearNpdFirstOrderRequest(storage: RequestStorage, actorId: number, projectId: number, expectedKey?: string): NpdFirstOrderRequest | null {
  if (expectedKey) {
    const current = loadNpdFirstOrderRequest(storage, actorId, projectId);
    if (current?.requestKey !== expectedKey) return current;
  }
  storage.removeItem(keyFor(actorId, projectId));
  return loadNpdFirstOrderRequest(storage, actorId, projectId);
}

/** Bounded wait, never an automatic retry. Aborting a response does not cancel a committed draft. */
export async function submitNpdFirstOrderRequest(request: NpdFirstOrderRequest, timeoutMs = 20_000) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Error("首单响应超时，服务端可能已生成草稿；已保留原请求，请核对项目后重试原请求"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([fetchJson<{ id: number; docNo: string; replayed: boolean }>("/api/npd/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "first_order", ...request }), signal: controller.signal,
    }), timeout]);
    if (!Number.isInteger(result?.id) || result.id <= 0 || typeof result.docNo !== "string" || !result.docNo.startsWith("BH-") || typeof result.replayed !== "boolean") {
      throw Error("首单结果格式异常，已保留原请求，请核对后重试原请求");
    }
    return result;
  } finally { clearTimeout(timer); }
}
