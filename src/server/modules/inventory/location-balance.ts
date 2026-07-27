import { and, eq, gt, isNull, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dQty } from "@/server/core/decimal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export function locationBatchKey(batchId: number | null): string {
  return batchId == null ? "null" : String(batchId);
}

/** 读取仓库总账之下、已明确定位到库位的数量。 */
export async function getLocatedQty(
  db: AnyDb,
  args: { warehouseId: number; skuId: number; batchId?: number | null },
): Promise<string> {
  const batchId = args.batchId ?? null;
  const [row]: { qty: string | null }[] = await db
    .select({ qty: sql<string>`coalesce(sum(${schema.binBalances.qty}), 0)` })
    .from(schema.binBalances)
    .innerJoin(schema.bins, eq(schema.binBalances.binId, schema.bins.id))
    .where(and(
      eq(schema.bins.warehouseId, args.warehouseId),
      eq(schema.binBalances.skuId, args.skuId),
      batchId == null
        ? isNull(schema.binBalances.batchId)
        : eq(schema.binBalances.batchId, batchId),
      gt(schema.binBalances.qty, "0"),
    ));
  return dQty(row?.qty ?? "0");
}

/** FEFO/预览批量取数：同一 SKU×仓按批次汇总已定位量，避免逐批 N+1。 */
export async function listLocatedQtyByBatch(
  db: AnyDb,
  args: { warehouseId: number; skuId: number },
): Promise<Map<string, string>> {
  const rows: { batchId: number | null; qty: string | null }[] = await db
    .select({
      batchId: schema.binBalances.batchId,
      qty: sql<string>`coalesce(sum(${schema.binBalances.qty}), 0)`,
    })
    .from(schema.binBalances)
    .innerJoin(schema.bins, eq(schema.binBalances.binId, schema.bins.id))
    .where(and(
      eq(schema.bins.warehouseId, args.warehouseId),
      eq(schema.binBalances.skuId, args.skuId),
      gt(schema.binBalances.qty, "0"),
    ))
    .groupBy(schema.binBalances.batchId);
  return new Map(rows.map((row) => [locationBatchKey(row.batchId), dQty(row.qty ?? "0")]));
}
