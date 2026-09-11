"use client";

import { useEffect, useState } from "react";

export const ENTITY_SEARCH_API = "/api/search";
interface SearchItem { label: string; href: string; tag?: string }
export interface SearchGroup { title: string; items: SearchItem[] }
type Phase = "idle" | "loading" | "success" | "error";
interface Result { key: string; phase: Phase; groups: SearchGroup[]; error: string | null }
const EMPTY: SearchGroup[] = [];
class SearchReadError extends Error {}

/** A malformed response is a failed read, not an empty search. Never navigate off-origin. */
export function readSearchGroups(body: unknown): SearchGroup[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { groups?: unknown }).groups)) throw new SearchReadError("搜索数据格式异常");
  const groups = (body as { groups: unknown[] }).groups;
  for (const group of groups) {
    if (!group || typeof group !== "object") throw new SearchReadError("搜索数据格式异常");
    const g = group as SearchGroup;
    if (typeof g.title !== "string" || !Array.isArray(g.items)) throw new SearchReadError("搜索数据格式异常");
    for (const item of g.items) {
      if (!item || typeof item.label !== "string" || typeof item.href !== "string" ||
        !/^\/(?!\/)/.test(item.href) || /[\\\u0000-\u0020]/.test(item.href) ||
        (item.tag !== undefined && typeof item.tag !== "string")) throw new SearchReadError("搜索数据格式异常");
    }
  }
  return groups as SearchGroup[];
}

/** Shared request lifecycle for header search and the command palette; no cross-user cache. */
export function useEntitySearch(query: string, enabled = true) {
  const q = query.trim();
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([q, attempt]);
  const active = enabled && q.length >= 2;
  const [result, setResult] = useState<Result>({ key: "", phase: "idle", groups: EMPTY, error: null });

  useEffect(() => {
    if (!active) {
      setResult({ key, phase: "idle", groups: EMPTY, error: null });
      return;
    }
    const request = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setResult({ key, phase: "loading", groups: EMPTY, error: null });
    const debounce = setTimeout(async () => {
      timeout = setTimeout(() => {
        if (request.signal.aborted) return;
        request.abort();
        setResult({ key, phase: "error", groups: EMPTY, error: "搜索超时，请重试" });
      }, 10_000);
      try {
        const res = await fetch(ENTITY_SEARCH_API + "?q=" + encodeURIComponent(q), { signal: request.signal });
        if (!res.ok) throw new SearchReadError(res.status === 401 ? "登录已失效，请重新登录" : res.status === 403 ? "当前账号无搜索权限" : "搜索服务暂不可用，请重试");
        const groups = readSearchGroups(await res.json());
        if (!request.signal.aborted) setResult({ key, phase: "success", groups, error: null });
      } catch (error) {
        if (!request.signal.aborted) setResult({ key, phase: "error", groups: EMPTY, error: error instanceof SearchReadError ? error.message : "网络或响应异常，请重试" });
      } finally {
        clearTimeout(timeout);
      }
    }, 300);
    return () => { clearTimeout(debounce); clearTimeout(timeout); request.abort(); };
  }, [active, key, q]);

  // Hide old rows before effect cleanup, not just after a replacement reply arrives.
  const current = active && result.key === key;
  const phase: Phase = !active ? "idle" : current ? result.phase : "loading";
  const groups = current && phase === "success" ? result.groups : EMPTY;
  const entries = groups.flatMap((group, gi) => group.items.map((item, ii) => ({
    ...item, group: group.title, value: "e:" + key + ":" + gi + ":" + ii + ":" + item.href,
  })));
  return { phase, entries, error: current ? result.error : null, retry: () => setAttempt(n => n + 1) };
}
