"use client";

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

/** 只展示约定的短纯文本错误，不回显代理 HTML、对象或原始响应；脱敏仍由服务端负责。 */
export function serverErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body) || typeof body.error !== "string") return null;
  const message = body.error.trim();
  if (!message || message.length > 500 || /[\p{Cc}\p{Cf}]/u.test(message) || /<\/?[a-z][^>]*>/i.test(message)) return null;
  return message;
}

function unconfirmedMessage(message: string, init?: RequestInit): string {
  const method = (init?.method ?? "GET").toUpperCase();
  return ["GET", "HEAD", "OPTIONS"].includes(method)
    ? message
    : `${message}。操作可能已在服务端完成，请先核对结果，勿重复提交`;
}

/**
 * JSON 响应契约：成功也必须有合法 JSON（204/205 不适用此 helper）；不验证业务 DTO 形状。
 * 不自动重试。取消在请求与响应体阶段均向上传递，不能伪装成空数据或普通服务错误。
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const signal = init?.signal;
  signal?.throwIfAborted();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new Error(unconfirmedMessage("网络连接异常，未能获取服务器响应", init));
  }
  signal?.throwIfAborted();

  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) throw error;
    const message = res.ok ? "服务器响应不是有效的 JSON" : `请求失败（${res.status}）`;
    throw new Error(unconfirmedMessage(message, init));
  }
  signal?.throwIfAborted();
  if (!res.ok) {
    const message = serverErrorMessage(body) ?? `请求失败（${res.status}）`;
    throw new Error(res.status >= 500 ? unconfirmedMessage(message, init) : message);
  }
  return body as T;
}

export function postJson<T>(url: string, data: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function patchJson<T>(url: string, data: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function putJson<T>(url: string, data: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
