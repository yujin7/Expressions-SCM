const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class IntegrationHttpError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "IntegrationHttpError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export interface FetchJsonOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(0, date - Date.now()), 30_000);
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * External-API transport with bounded timeout and retry. Errors intentionally contain only the
 * service label/status: request URLs, headers, bodies, access tokens, and vendor payloads are never
 * copied into logs or database error fields.
 */
export async function fetchJson(
  service: string,
  url: string,
  init: RequestInit,
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const retryable = RETRYABLE_STATUS.has(response.status);
        if (retryable && attempt < retries) {
          await sleep(retryAfterMs(response) ?? backoffMs(attempt));
          continue;
        }
        throw new IntegrationHttpError(`${service} HTTP ${response.status}`, {
          status: response.status,
          retryable,
        });
      }
      try {
        return await response.json();
      } catch {
        throw new IntegrationHttpError(`${service} 返回非 JSON 响应`, {
          status: response.status,
          retryable: false,
        });
      }
    } catch (error) {
      if (error instanceof IntegrationHttpError) throw error;
      const timedOut = controller.signal.aborted;
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new IntegrationHttpError(
        timedOut ? `${service} 请求超时` : `${service} 网络请求失败`,
        { retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new IntegrationHttpError(`${service} 请求失败`, { retryable: true });
}
