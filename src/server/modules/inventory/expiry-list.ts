/**
 * 效期批次清单（仓库操作层——与 replenish/expiry.ts 的 SKU 级检查互补：
 * 本页给仓管逐「批次×仓库」的实物处置视图，风险处置页给 PMC 逐 SKU 的决策视图）。
 *
 * 口径：batch_stocks 参考层（非账本），qty>0 且 expiryDate 非空；
 * daysLeft = expiryDate − 今日（Asia/Shanghai，可为负）；段位与驾驶舱七段前四段对齐：
 * expired(≤0) / m3(≤90) / m6(≤180) / rest(>180)。默认排序 daysLeft 升序（最紧急最上）。
 * 无金额字段，免脱敏；只读。
 */
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";
import { num } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type ExpiryBucket = "expired" | "m3" | "m6" | "rest";

export interface ExpiryBatchRow {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  brand: string | null;
  warehouse: string;
  batchNo: string | null;
  productionDate: string | null;
  expiryDate: string;
  daysLeft: number;
  qty: number;
  bucket: ExpiryBucket;
}

export interface ExpiryListResult {
  today: string;
  rows: ExpiryBatchRow[];
  total: number;
  bucketCounts: Record<ExpiryBucket, { batches: number; qty: number }>;
}

function bucketOf(daysLeft: number): ExpiryBucket {
  if (daysLeft <= 0) return "expired";
  if (daysLeft <= 90) return "m3";
  if (daysLeft <= 180) return "m6";
  return "rest";
}

export async function listExpiryBatches(
  query: { q?: string; bucket?: string; warehouseId?: number; page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<ExpiryListResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = todayShanghai();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();

  const bs = schema.batchStocks;
  const conds = [isNotNull(bs.expiryDate), gt(bs.qty, "0")];
  if (query.warehouseId) conds.push(eq(bs.warehouseId, query.warehouseId));
  const raw: {
    id: number; skuId: number; skuCode: string; skuName: string; brand: string | null;
    warehouse: string; batchNo: string | null; productionDate: string | null; expiryDate: string; qty: string;
  }[] = await db
    .select({
      id: bs.id,
      skuId: bs.skuId,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      brand: schema.brands.nameCn,
      warehouse: schema.warehouses.name,
      batchNo: bs.batchNo,
      productionDate: bs.prodDate,
      expiryDate: bs.expiryDate,
      qty: bs.qty,
    })
    .from(bs)
    .innerJoin(schema.skus, eq(bs.skuId, schema.skus.id))
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .innerJoin(schema.warehouses, eq(bs.warehouseId, schema.warehouses.id))
    .where(and(...conds));

  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const all: ExpiryBatchRow[] = raw.map((r) => {
    const daysLeft = Math.round((Date.parse(`${r.expiryDate}T00:00:00Z`) - todayMs) / 86_400_000);
    return { ...r, qty: num(r.qty), daysLeft, bucket: bucketOf(daysLeft) };
  });

  const bucketCounts: Record<ExpiryBucket, { batches: number; qty: number }> = {
    expired: { batches: 0, qty: 0 },
    m3: { batches: 0, qty: 0 },
    m6: { batches: 0, qty: 0 },
    rest: { batches: 0, qty: 0 },
  };
  for (const r of all) {
    bucketCounts[r.bucket].batches++;
    bucketCounts[r.bucket].qty += r.qty;
  }

  let filtered = all;
  if (query.bucket && query.bucket in bucketCounts) filtered = filtered.filter((r) => r.bucket === query.bucket);
  if (q) {
    filtered = filtered.filter(
      (r) =>
        r.skuCode.toLowerCase().includes(q) ||
        r.skuName.toLowerCase().includes(q) ||
        (r.batchNo ?? "").toLowerCase().includes(q),
    );
  }
  filtered.sort((a, b) => a.daysLeft - b.daysLeft || b.qty - a.qty);
  return {
    today,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    bucketCounts,
  };
}
