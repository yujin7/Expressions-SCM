/**
 * 批次过账迁移闸门与出库 FEFO 展开。
 *
 * `batch_posting_enabled=0` 时保持原单行，不改变现网余额维度；打开后：
 * - 未指定批次的出库行按 SKU 汇总后一次 FEFO 分配，再稳定拆回原业务行；
 * - 显式批次必须属于该 SKU、未过期且库存足够；
 * - 同一 SKU 不允许混用显式批次和自动分配，避免双重占用；
 * - 批次库存不足时拒绝建单，不生成“部分可执行”草稿。
 */
import { and, eq, inArray } from "drizzle-orm";
import { batches, stockBalances } from "@/db/schema";
import { dAdd, dCmp, dQty, dSub } from "@/server/core/decimal";
import { getNumParam } from "@/server/core/params";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { suggestFefoAllocation } from "./fefo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface BatchAllocatableLine {
  skuId: number;
  qty: string;
  batchId?: number | null;
}

export async function isBatchPostingEnabled(db: AnyDb): Promise<boolean> {
  return (await getNumParam("batch_posting_enabled", 0, db)) === 1;
}

export async function expandOutboundLinesForBatchPosting<T extends BatchAllocatableLine>(
  db: AnyDb,
  warehouseId: number,
  input: T[],
): Promise<Array<Omit<T, "qty" | "batchId"> & { qty: string; batchId: number | null }>> {
  const normalized = input.map((line) => ({
    ...line,
    qty: dQty(line.qty),
    batchId: line.batchId ?? null,
  }));
  if (!(await isBatchPostingEnabled(db))) return normalized;

  const result: Array<Omit<T, "qty" | "batchId"> & { qty: string; batchId: number | null }> = [];
  const skuIds = [...new Set(normalized.map((line) => line.skuId))];

  for (const skuId of skuIds) {
    const group = normalized.filter((line) => line.skuId === skuId);
    const explicit = group.filter((line) => line.batchId != null);
    const automatic = group.filter((line) => line.batchId == null);
    if (explicit.length > 0 && automatic.length > 0) {
      throw new ApiError(400, `同一 SKU 不可混用显式批次与自动 FEFO: sku#${skuId}`);
    }

    if (explicit.length > 0) {
      const ids = [...new Set(explicit.map((line) => line.batchId as number))];
      const rows: { id: number; skuId: number; expiryDate: string | null }[] = await db
        .select({ id: batches.id, skuId: batches.skuId, expiryDate: batches.expiryDate })
        .from(batches)
        .where(inArray(batches.id, ids));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const today = todayShanghai();
      const qtyByBatch = new Map<number, string>();
      for (const line of explicit) {
        const batchId = line.batchId as number;
        const batch = byId.get(batchId);
        if (!batch || batch.skuId !== skuId) {
          throw new ApiError(400, `批次不存在或不属于该 SKU: batch#${batchId} / sku#${skuId}`);
        }
        if (batch.expiryDate != null && batch.expiryDate <= today) {
          throw new ApiError(409, `过期批次不可出库: batch#${batchId}（效期 ${batch.expiryDate}）`);
        }
        qtyByBatch.set(batchId, dAdd(qtyByBatch.get(batchId) ?? "0", line.qty));
      }
      for (const [batchId, required] of qtyByBatch) {
        const [balance]: { qty: string }[] = await db
          .select({ qty: stockBalances.qty })
          .from(stockBalances)
          .where(and(
            eq(stockBalances.skuId, skuId),
            eq(stockBalances.warehouseId, warehouseId),
            eq(stockBalances.batchId, batchId),
          ));
        if (!balance || dCmp(balance.qty, required) < 0) {
          throw new ApiError(
            409,
            `批次库存不足: sku#${skuId} batch#${batchId}（可用 ${balance?.qty ?? "0"}，需 ${required}）`,
          );
        }
      }
      result.push(...explicit);
      continue;
    }

    let total = "0";
    for (const line of automatic) total = dAdd(total, line.qty);
    const suggestion = await suggestFefoAllocation(db, { skuId, warehouseId, qty: total });
    if (!suggestion.batchCoverage) {
      // 尚未批次化的历史 SKU 继续走 null 余额；过账引擎仍负责非负校验。
      result.push(...automatic);
      continue;
    }
    if (dCmp(suggestion.shortBy, "0") > 0) {
      const expired = suggestion.expiredLots > 0 ? `；已排除过期批次 ${suggestion.expiredLots} 个` : "";
      throw new ApiError(409, `FEFO 可发库存不足: sku#${skuId}（缺 ${suggestion.shortBy}${expired}）`);
    }

    const pool: { batchId: number | null; qty: string }[] = [
      ...suggestion.allocations.map((allocation) => ({ batchId: allocation.batchId, qty: allocation.qty })),
      ...(dCmp(suggestion.fallbackQty, "0") > 0
        ? [{ batchId: null, qty: suggestion.fallbackQty }]
        : []),
    ];
    let poolIndex = 0;
    for (const line of automatic) {
      let remaining = line.qty;
      while (dCmp(remaining, "0") > 0) {
        const slot = pool[poolIndex];
        if (!slot) throw new ApiError(500, `FEFO 分配内部不平: sku#${skuId}`);
        const take = dCmp(slot.qty, remaining) <= 0 ? slot.qty : remaining;
        result.push({ ...line, qty: dQty(take), batchId: slot.batchId });
        remaining = dSub(remaining, take, 6);
        slot.qty = dSub(slot.qty, take, 6);
        if (dCmp(slot.qty, "0") <= 0) poolIndex++;
      }
    }
  }

  return result;
}
