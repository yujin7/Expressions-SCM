"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "./fetchJson";

type Phase = "idle" | "loading" | "success" | "error";
interface ReadState<T> { key: string; phase: Phase; data: T | null; error: string | null }

/** Identity-bound document GETs. No cache, automatic retry, or business mutations. */
export function useDocumentRead<T>(url: string | null) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([url, attempt]);
  const [state, setState] = useState<ReadState<T>>({ key: "", phase: "idle", data: null, error: null });
  const retry = useCallback(() => setAttempt(n => n + 1), []);

  useEffect(() => {
    if (!url) {
      setState({ key, phase: "idle", data: null, error: null });
      return;
    }
    const request = new AbortController();
    setState({ key, phase: "loading", data: null, error: null });
    const timeout = setTimeout(() => {
      request.abort();
      setState({ key, phase: "error", data: null, error: "读取超时，请重试" });
    }, 15_000);
    void fetchJson<T>(url, { signal: request.signal }).then(data => {
      if (request.signal.aborted) return;
      if (data == null) throw new Error("服务器未返回单据数据");
      setState({ key, phase: "success", data, error: null });
    }).catch((error: unknown) => {
      if (!request.signal.aborted) setState({ key, phase: "error", data: null,
        error: error instanceof Error ? error.message : "读取失败，请重试" });
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); request.abort(); };
  }, [url, key]);

  // Withdraw obsolete facts/actions during render, before effects have cleaned up the old request.
  const current = url !== null && state.key === key;
  const phase: Phase = !url ? "idle" : current ? state.phase : "loading";
  return { phase, data: current && phase === "success" ? state.data : null,
    error: current ? state.error : null, retry };
}
