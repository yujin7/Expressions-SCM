"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { fetchJson } from "./fetchJson";

const count = z.number().int().nonnegative();
const itemSchema = z.object({
  skuId: z.number().int().positive(), skuCode: z.string().min(1), skuKnown: z.boolean(),
  baseUom: z.string().nullable(), thresholdDays: count, referenceRows: count,
  nearBatches: count, undatedPositiveRows: count, minDaysLeft: z.number().int().nullable(),
  stocktakeDates: z.array(z.string().date()), stocktakeAgeDays: z.number().int().nullable(),
  nearQtyExact: z.string().regex(/^\d+\.\d{4}$/), expiredQtyExact: z.string().regex(/^\d+\.\d{4}$/),
});
const responseSchema = z.object({
  source: z.literal("batch_stock_reference"), today: z.string().date(),
  warehouseId: z.number().int().positive(), items: z.array(itemSchema),
});
export type ExpiryReferenceData = z.infer<typeof responseSchema>;
type Phase = "idle" | "loading" | "success" | "error";
type State = { key: string; phase: Phase; data: ExpiryReferenceData | null; error: string | null };

/** Quantity, line order and duplicate SKU lines do not alter this read's scope. */
export function expiryReferenceKey(active: boolean, warehouseId: unknown, lines: unknown): string | null {
  if (!active || typeof warehouseId !== "number" || !Number.isInteger(warehouseId) || warehouseId <= 0 || warehouseId > 2147483647) return null;
  const skuIds = [...new Set((Array.isArray(lines) ? lines : []).map((line: { skuId?: unknown } | null) => line?.skuId)
    .filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0 && id <= 2147483647))].sort((a, b) => a - b);
  return skuIds.length ? JSON.stringify({ warehouseId, skuIds }) : null;
}

/** Debounced, bounded, all-or-nothing GETs; a warning failure never authorizes a stock movement. */
export function useExpiryReference(inputKey: string | null) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([inputKey, attempt]);
  const [state, setState] = useState<State>({ key: "", phase: "idle", data: null, error: null });
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  useEffect(() => {
    if (!inputKey) {
      setState({ key, phase: "idle", data: null, error: null });
      return;
    }
    const request = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setState({ key, phase: "loading", data: null, error: null });
    const timer = setTimeout(() => {
      const input = JSON.parse(inputKey) as { warehouseId: number; skuIds: number[] };
      if (input.skuIds.length > 1000) {
        setState({ key, phase: "error", data: null, error: "本次效期参考最多核对 1000 个 SKU，请拆分单据后核对" });
        return;
      }
      timeout = setTimeout(() => {
        request.abort();
        setState({ key, phase: "error", data: null, error: "效期参考读取超时，请重试" });
      }, 15_000);
      const chunks: number[][] = [];
      for (let i = 0; i < input.skuIds.length; i += 200) chunks.push(input.skuIds.slice(i, i + 200));
      void Promise.all(chunks.map(async ids => {
        const params = new URLSearchParams({ skuIds: ids.join(","), warehouseId: String(input.warehouseId) });
        const parsed = responseSchema.safeParse(await fetchJson<unknown>(`/api/inventory/expiry-check?${params}`, { signal: request.signal, cache: "no-store" }));
        if (!parsed.success) throw new Error("效期参考响应不完整，请重试或联系管理员");
        const data = parsed.data;
        if (data.warehouseId !== input.warehouseId || data.items.length !== ids.length || new Set(data.items.map(i => i.skuId)).size !== ids.length || data.items.some(i => !ids.includes(i.skuId))) {
          throw new Error("效期参考与当前仓库或 SKU 不一致，请重试");
        }
        return data;
      })).then(results => {
        if (request.signal.aborted) return;
        if (results.some(r => r.today !== results[0].today)) throw new Error("效期检查跨越业务日，请重试以统一日期");
        setState({ key, phase: "success", error: null, data: { ...results[0], items: results.flatMap(r => r.items) } });
      }).catch((error: unknown) => {
        if (request.signal.aborted) return;
        request.abort(); // Stop sibling chunks; never publish a partial success.
        setState({ key, phase: "error", data: null, error: error instanceof Error ? error.message : "效期参考读取失败，请重试" });
      }).finally(() => clearTimeout(timeout));
    }, 500);
    return () => { clearTimeout(timer); clearTimeout(timeout); request.abort(); };
  }, [inputKey, key]);
  const current = inputKey !== null && state.key === key;
  const phase: Phase = !inputKey ? "idle" : current ? state.phase : "loading";
  return { phase, data: current && phase === "success" ? state.data : null, error: current ? state.error : null, retry };
}
