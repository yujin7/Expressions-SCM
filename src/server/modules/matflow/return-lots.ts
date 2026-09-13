import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { batches, stockBalances } from "@/db/schema";
import { dAdd, dCmp, dQty, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";
import { isBatchPostingEnabled, type BatchAllocatableLine } from "@/server/modules/inventory/batch-allocation";
import { getLocatedQty } from "@/server/modules/inventory/location-balance";
import { getJgForMatflow, getOutsourceWarehouseOf } from "./common-notes";

/** Return the physical lot the operator identified, never replace it with FEFO stock. */
export async function resolveTlPhysicalLines<T extends BatchAllocatableLine>(db: AnyDb, warehouseId: number, input: T[]) {
  const enabled = await isBatchPostingEnabled(db);
  const grouped = new Map<string, { skuId: number; batchId: number | null; qty: string }>();
  for (const line of input) {
    if (line.batchId === undefined && enabled) {
      const [covered] = await db.select({ id: stockBalances.id }).from(stockBalances)
        .where(and(eq(stockBalances.warehouseId, warehouseId), eq(stockBalances.skuId, line.skuId), sql`${stockBalances.batchId} is not null`)).limit(1);
      if (covered) throw new ApiError(409, "请明确选择实际退回批次；历史无批次库存须显式确认，不自动按FEFO替换实物");
    }
    const batchId = line.batchId ?? null;
    if (batchId != null) {
      const [batch] = await db.select({ skuId: batches.skuId }).from(batches).where(eq(batches.id, batchId));
      if (!batch || batch.skuId !== line.skuId) throw new ApiError(400, "退回批次不存在或不属于该物料，请核对实物身份");
    }
    const key = `${line.skuId}:${batchId}`;
    const previous = grouped.get(key);
    grouped.set(key, { skuId: line.skuId, batchId, qty: dAdd(previous?.qty ?? "0", line.qty) });
  }
  if (enabled) for (const line of grouped.values()) {
    const [balance] = await db.select({ qty: stockBalances.qty }).from(stockBalances).where(and(
      eq(stockBalances.warehouseId, warehouseId), eq(stockBalances.skuId, line.skuId),
      line.batchId == null ? isNull(stockBalances.batchId) : eq(stockBalances.batchId, line.batchId)));
    const located = await getLocatedQty(db, { warehouseId, ...line });
    if (dCmp(dSub(balance?.qty ?? "0", located), line.qty) < 0) throw new ApiError(409,
      `实际退回批次库存不足（未定位口径）：物料#${line.skuId}，批次${line.batchId ?? "历史无批次"}；请核对原仓、实物及库位，不借用其他批次`);
  }
  return input.map(line => ({ ...line, qty: dQty(line.qty), batchId: line.batchId ?? null }));
}

/** Bounded choice list; warehouse balance is not proof of this JG's ownership. */
export async function listTlReturnLots(user: SessionUser, input: {
  jgId: number; warehouseId: number; skuId: number; q: string; page: number; pageSize: number; ids?: string[];
}, dbArg?: AnyDb) {
  requireAnyRole(user, "warehouse");
  const db = await resolveDb(dbArg), jg = await getJgForMatflow(db, input.jgId, "return");
  await getOutsourceWarehouseOf(db, jg.supplierId, input.warehouseId);
  const ids = input.ids?.filter(id => id !== "unbatched").map(Number) ?? [];
  const where = and(eq(stockBalances.warehouseId, input.warehouseId), eq(stockBalances.skuId, input.skuId),
    gt(stockBalances.qty, "0"), or(isNull(stockBalances.batchId), eq(batches.skuId, stockBalances.skuId)),
    input.q ? sql`coalesce(${batches.batchNo},'历史无批次') ilike ${`%${input.q.replace(/[\\%_]/g, "\\$&")}%`}` : undefined,
    input.ids ? (input.ids.length ? or(ids.length ? inArray(stockBalances.batchId, ids) : undefined,
      input.ids.includes("unbatched") ? isNull(stockBalances.batchId) : undefined) : sql`false`) : undefined);
  const rows = await db.select({ id: stockBalances.id, batchId: stockBalances.batchId, batchNo: batches.batchNo,
    expiryDate: batches.expiryDate, qty: stockBalances.qty,
    locatedQty: sql<string>`(select coalesce(sum(bb.qty),0)::text from bin_balances bb join bins bin on bin.id=bb.bin_id
      where bin.warehouse_id=${stockBalances.warehouseId} and bb.sku_id=${stockBalances.skuId}
        and bb.batch_id is not distinct from ${stockBalances.batchId} and bb.qty>0)`,
  }).from(stockBalances).leftJoin(batches, eq(stockBalances.batchId, batches.id)).where(where)
    .orderBy(stockBalances.id).limit(input.pageSize).offset((input.page - 1) * input.pageSize);
  const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(stockBalances)
    .leftJoin(batches, eq(stockBalances.batchId, batches.id)).where(where);
  return { rows: rows.map((row: { id: number; batchId: number | null; batchNo: string | null; expiryDate: string | null; qty: string; locatedQty: string }) => ({
    ...row, availableQty: dCmp(dSub(row.qty, row.locatedQty), "0") > 0 ? dSub(row.qty, row.locatedQty) : "0.0000",
  })), total: count.total };
}
