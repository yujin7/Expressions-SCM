"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { fetchJson } from "./fetchJson";

const id = z.number().int().positive().max(2147483647);
// Input validation only; quantity arithmetic stays in the server decimal authority.
const qty = z.union([z.string(), z.number()]).transform(v => String(v).trim())
  .pipe(z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, "数量须为最多4位小数的正数")
    .refine(v => !/^0+(\.0+)?$/.test(v), "数量必须大于0"));
const inputSchema = z.object({ subtype: z.enum(["issue_out", "sales_out", "transfer"]), warehouseId: id, riskDisposalId: id.nullable().optional(),
  lines: z.array(z.object({ skuId: id, qty, batchId: id.nullable().optional() })).min(1).max(1000) })
  .refine(v => !v.riskDisposalId || (v.subtype === "issue_out" && new Set(v.lines.map(line => line.skuId)).size === 1), "报废评审仅限对应单一SKU的领料出");
export function fefoPreviewKey(input: unknown): string {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw Error("请完整填写出库类型、仓库和SKU；每行数量须大于0且最多4位小数");
  return JSON.stringify(parsed.data);
}
export function currentFefoPreviewKey(input: unknown): string | null {
  try { return fefoPreviewKey(input); } catch { return null; }
}
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const groupSchema = z.object({ skuId: id, warehouseId: id, sourceQuantities: z.array(qty).min(1),
  sourceBatchIds: z.array(id.nullable()).min(1), mode: z.enum(["automatic", "explicit"]), riskDisposalId: id.nullable(),
  skuCode: z.string(), skuName: z.string().nullable(), baseUom: z.string().min(1), requestedQty: decimal,
  allocations: z.array(z.object({ batchId: id, batchNo: z.string(), expiryDate: z.string().nullable(), qty: decimal })),
  fallbackQty: decimal, shortBy: decimal, expiredLots: z.number().int().nonnegative(), batchCoverage: z.boolean(), note: z.string() });
export type FefoPreviewGroup = z.infer<typeof groupSchema>;

/** One exact, all-or-nothing preview. Input changes withdraw results before effect cleanup. */
export function useFefoPreview(target: string | null, currentInput: string | null) {
  const [attempt, setAttempt] = useState(0);
  const effectiveTarget = target === currentInput ? target : null;
  const key = JSON.stringify([effectiveTarget, attempt]);
  const [state, setState] = useState<{ key: string; groups: FefoPreviewGroup[] | null; error: string | null }>({ key: "", groups: null, error: null });
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  useEffect(() => {
    if (!effectiveTarget) { setState({ key, groups: null, error: null }); return; }
    const request = new AbortController();
    setState({ key, groups: null, error: null });
    const timer = setTimeout(() => { request.abort(); setState({ key, groups: null, error: "批次预览读取超时，请重试" }); }, 15_000);
    void (async () => {
      const input = inputSchema.parse(JSON.parse(effectiveTarget));
      const quantities = new Map<number, typeof input.lines>();
      for (const line of input.lines) quantities.set(line.skuId, [...(quantities.get(line.skuId) ?? []), line]);
      const groups = await Promise.all([...quantities].map(async ([skuId, lines]) => {
        const sourceQuantities = lines.map(line => line.qty), sourceBatchIds = lines.map(line => line.batchId ?? null);
        const params = new URLSearchParams({ skuId: String(skuId), warehouseId: String(input.warehouseId) });
        if (input.riskDisposalId) params.set("riskDisposalId", String(input.riskDisposalId));
        for (const line of lines) { params.append("qty", line.qty); params.append("batchId", line.batchId == null ? "auto" : String(line.batchId)); }
        const parsed = groupSchema.safeParse(await fetchJson<unknown>(`/api/inventory/fefo-suggest?${params}`, { signal: request.signal, cache: "no-store" }));
        if (!parsed.success) throw Error("批次预览响应不完整，请重试；未沿用旧结果");
        const group = parsed.data;
        if (group.skuId !== skuId || group.warehouseId !== input.warehouseId || group.riskDisposalId !== (input.riskDisposalId ?? null) || JSON.stringify(group.sourceQuantities) !== JSON.stringify(sourceQuantities)
          || JSON.stringify(group.sourceBatchIds) !== JSON.stringify(sourceBatchIds) || group.mode !== (sourceBatchIds[0] == null ? "automatic" : "explicit")) {
          throw Error("批次预览与当前仓库、SKU或数量不符，请重新读取");
        }
        return group;
      }));
      if (!request.signal.aborted) setState({ key, groups, error: null });
    })().catch((error: unknown) => {
      if (!request.signal.aborted) { request.abort(); setState({ key, groups: null, error: error instanceof Error ? error.message : "批次预览失败，请重试" }); }
    }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); request.abort(); };
  }, [effectiveTarget, key]);
  const current = effectiveTarget !== null && state.key === key;
  const error = target && !effectiveTarget ? "仓库、SKU或数量已变化，请返回修改后重新预览" : current ? state.error : null;
  return { groups: current && !error ? state.groups : null, error,
    loading: effectiveTarget !== null && !error && (!current || state.groups === null), retry };
}
