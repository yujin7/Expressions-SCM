"use client";

import { fetchJson } from "./fetchJson";

/** Bounded wait, never an automatic retry: an aborted response is not a rolled-back write. */
export async function submitSupplierWork(url: string, method: "POST" | "PATCH", payload: unknown) {
  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 30_000);
  try {
    const result = await fetchJson<{ id: number; status: "open" | "closed" }>(url, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: request.signal,
    });
    if (!result || !Number.isSafeInteger(result.id) || result.id < 1 || !["open", "closed"].includes(result.status)) {
      throw new Error("返回的工作项回执格式异常。操作可能已完成，请先核对记录，不要重新发起");
    }
    return result;
  } catch (error) {
    if (request.signal.aborted) throw new Error("等待回执超过30秒，操作可能已在服务端完成。输入已保留，请先核对记录；不要重新发起");
    throw error;
  } finally { clearTimeout(timeout); }
}

export function supplierWorkHref(id: number): string {
  return `/master/supplier/lifecycle?caseId=${id}&status=`;
}
