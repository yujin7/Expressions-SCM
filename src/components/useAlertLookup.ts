"use client";

import { useCallback, useEffect, useState } from "react";
import type { AlertEvidenceFields } from "./AlertEvidence";
import { fetchJson } from "./fetchJson";
import { alertLookupQueries, type AlertLookupCategory } from "@/lib/alert-lookup";

export interface AlertRef extends AlertEvidenceFields { id: number; dedupeKey: string | null; status: string; ownerRole?: string | null }
interface LookupPage { rows: AlertRef[]; total: number; unackedTotal: number }
interface LookupData { byKey: Record<string, AlertRef>; unacked: number }
type Phase = "idle" | "loading" | "success" | "error";

/** Bounded requests for the displayed identities; never scan unrelated pages of alerts. */
export async function loadAlertLookup(category: AlertLookupCategory, keys: readonly string[], signal: AbortSignal): Promise<LookupData> {
  const queries = alertLookupQueries(category, keys);
  const pages: LookupPage[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, queries.length) }, async () => {
    while (cursor < queries.length) {
      signal.throwIfAborted();
      const index = cursor++;
      const page = await fetchJson<LookupPage>(queries[index], { signal });
      if (!page || !Array.isArray(page.rows) || page.total !== page.rows.length
        || !Number.isSafeInteger(page.unackedTotal) || page.unackedTotal < 0) {
        throw new Error("告警关联响应不完整，请重试");
      }
      const requested = new Set<string>(JSON.parse(new URL(queries[index], "http://localhost").searchParams.get("keys")!));
      if (page.rows.some(row => !row || !Number.isSafeInteger(row.id) || row.id <= 0 || !row.dedupeKey
        || !requested.has(row.dedupeKey) || row.status !== "open")
        || new Set(page.rows.map(row => row.dedupeKey)).size !== page.rows.length) {
        throw new Error("告警关联响应格式异常，请重试");
      }
      pages[index] = page;
    }
  }));
  signal.throwIfAborted();
  return { byKey: Object.fromEntries(pages.flatMap(page => page.rows.map(row => [row.dedupeKey!, row]))), unacked: pages[0].unackedTotal };
}

export function useAlertLookup(category: AlertLookupCategory, keys: readonly string[] | null) {
  const [attempt, setAttempt] = useState(0);
  const serialized = keys === null ? null : JSON.stringify([...new Set(keys)].sort());
  const key = JSON.stringify([category, serialized, attempt]);
  const [state, setState] = useState<{ key: string; phase: Phase; data: LookupData | null; error: string | null }>({ key: "", phase: "idle", data: null, error: null });
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  useEffect(() => {
    if (serialized === null) { setState({ key, phase: "idle", data: null, error: null }); return; }
    const request = new AbortController();
    setState({ key, phase: "loading", data: null, error: null });
    const timeout = setTimeout(() => {
      request.abort(); setState({ key, phase: "error", data: null, error: "告警关联读取超时，请重试" });
    }, 15_000);
    void loadAlertLookup(category, JSON.parse(serialized), request.signal).then(data => {
      if (!request.signal.aborted) setState({ key, phase: "success", data, error: null });
    }).catch((error: unknown) => {
      if (!request.signal.aborted) {
        request.abort(); // cancel sibling batches after one fails; no partial success is exposed
        setState({ key, phase: "error", data: null, error: error instanceof Error ? error.message : "告警关联读取失败，请重试" });
      }
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); request.abort(); };
  }, [category, serialized, key]);
  const current = serialized !== null && state.key === key;
  const phase: Phase = serialized === null ? "idle" : current ? state.phase : "loading";
  return { phase, byKey: current && phase === "success" ? state.data!.byKey : {},
    unacked: current && phase === "success" ? state.data!.unacked : null,
    error: current ? state.error : null, retry };
}
