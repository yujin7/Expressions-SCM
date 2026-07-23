"use client";

/** 统一 fetch：非 2xx 时抛出后端 {error} 中文消息 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `请求失败（${res.status}）`;
    throw new Error(msg);
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

export function putJson<T>(url: string, data: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
