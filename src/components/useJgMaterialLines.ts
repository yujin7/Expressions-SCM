"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "./fetchJson";
import { createLatestReadScope } from "./useLatestRead";

export interface JgMaterialLine {
  materialSkuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  grossReq: string;
}

/** One source-selection lane for FL/TL. Late results must never populate another JG. */
export function useJgMaterialLines(onLoaded: (lines: JgMaterialLine[]) => void) {
  const [scope] = useState(createLatestReadScope);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => scope.cancel, [scope]);

  const cancel = useCallback(() => {
    scope.cancel();
    setLoading(false);
    setError(null);
  }, [scope]);

  const load = useCallback(async (id: number) => {
    const request = scope.begin();
    onLoaded([]);
    setLoading(true);
    setError(null);
    try {
      const jg = await fetchJson<{ woId: number }>(`/api/outsource/jg/${id}`, { signal: request.signal });
      if (!request.isCurrent()) return;
      const wo = await fetchJson<{ lines: JgMaterialLine[] }>(`/api/outsource/wo/${jg.woId}`, { signal: request.signal });
      if (!request.isCurrent()) return;
      onLoaded(wo.lines);
    } catch (cause) {
      if (request.isCurrent()) setError(cause instanceof Error ? cause.message : "物料加载失败，请重试");
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [onLoaded, scope]);

  return { load, cancel, loading, error };
}
