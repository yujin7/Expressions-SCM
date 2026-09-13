"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "./fetchJson";
import { createLatestReadScope } from "./useLatestRead";
import type { JgMaterialBasis, JgMaterialLine } from "@/lib/matflow-basis";
export type { JgMaterialLine } from "@/lib/matflow-basis";

/** One source-selection lane for FL/TL. Late results must never populate another JG. */
export function useJgMaterialLines(onLoaded: (lines: JgMaterialLine[]) => void) {
  const [scope] = useState(createLatestReadScope);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [basis, setBasis] = useState<JgMaterialBasis | null>(null);
  useEffect(() => scope.cancel, [scope]);

  const cancel = useCallback(() => {
    scope.cancel();
    setLoading(false);
    setError(null);
    setSupplierId(null);
    setBasis(null);
  }, [scope]);

  const load = useCallback(async (id: number) => {
    const request = scope.begin();
    onLoaded([]);
    setSupplierId(null);
    setBasis(null);
    setLoading(true);
    setError(null);
    try {
      const current = await fetchJson<JgMaterialBasis>(`/api/outsource/jg/${id}?materialBasis=1`, { signal: request.signal, cache: "no-store" });
      if (!request.isCurrent()) return;
      if (current.jgId !== id) throw new Error("物料依据与当前加工单不符，请重试");
      if (!Array.isArray(current.woOpenIssues) || !Array.isArray(current.lines)
        || current.lines.some(line => [line.woIssuedQty, line.woDraftIssueQty, line.woPendingIssueQty].some(value => typeof value !== "string"))) {
        throw new Error("工单跨批次发料依据不完整，请刷新后重试；未沿用旧额度");
      }
      onLoaded(current.lines);
      setSupplierId(current.supplierId);
      setBasis(current);
    } catch (cause) {
      if (request.isCurrent()) setError(cause instanceof Error ? cause.message : "物料加载失败，请重试");
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [onLoaded, scope]);

  return { load, cancel, loading, error, supplierId, basis };
}
