/**
 * 效期批次清单（仓库操作层——与 replenish/expiry.ts 的 SKU 级检查互补：
 * 本页给仓管逐「批次×仓库」的实物处置视图，风险处置页给 PMC 逐 SKU 的决策视图）。
 *
 * 口径：batch_stocks 参考层（非账本），qty>0 且 expiryDate 非空；
 * daysLeft = expiryDate − 今日（Asia/Shanghai，可为负）；段位与驾驶舱七段完全对齐。
 * 无金额字段，免脱敏；只读。
 *
 * 2026-09-03 W2-J（BI-R3）：增 brand 筛选与「段位 × 品牌」矩阵（brandMatrix），
 * 矩阵与 bucketCounts 都在段位/搜索筛选**之前**统计（仓库筛选之后），指标 id expiryByBrand。
 */
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";
import { num } from "@/server/core/svc";
import { EXPIRY_TIER_DAYS, daysLeftOf, latestStocktakeRows, loadLatestStocktakeDates } from "@/server/core/stock-view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export type ExpiryBucket = "expired" | "m3" | "m6" | "m12" | "m18" | "m24" | "rest";

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

export interface ExpiryBrandMatrixRow {
  brand: string;
  buckets: Record<ExpiryBucket, { batches: number; qty: number }>;
  batches: number;
  qty: number;
}

export interface ExpiryListResult {
  today: string;
  rows: ExpiryBatchRow[];
  total: number;
  bucketCounts: Record<ExpiryBucket, { batches: number; qty: number }>;
  /** 段位 × 品牌矩阵（仓库筛选后、段位/搜索/品牌筛选前），按总数量降序；无品牌归「(未设品牌)」 */
  brandMatrix: ExpiryBrandMatrixRow[];
  /** 可选品牌（矩阵行名） */
  brands: string[];
  /** 当前品牌筛选（回显） */
  brand: string | null;
}

export const EXPIRY_NO_BRAND = "(未设品牌)";

const EXPIRY_BUCKETS: ExpiryBucket[] = ["expired", "m3", "m6", "m12", "m18", "m24", "rest"];
const emptyBuckets = (): Record<ExpiryBucket, { batches: number; qty: number }> =>
  Object.fromEntries(EXPIRY_BUCKETS.map((b) => [b, { batches: 0, qty: 0 }])) as Record<ExpiryBucket, { batches: number; qty: number }>;

export function expiryBucketOf(daysLeft: number): ExpiryBucket {
  // 边界走 core/stock-view.EXPIRY_TIER_DAYS（spec/07 N3 七段位口径 92/183），
  // 此前写死 90/180，与驾驶舱差 2-3 天，同一批货在两页会落到不同段位
  if (daysLeft <= 0) return "expired";
  if (daysLeft <= EXPIRY_TIER_DAYS.m3) return "m3";
  if (daysLeft <= EXPIRY_TIER_DAYS.m6) return "m6";
  if (daysLeft <= EXPIRY_TIER_DAYS.m12) return "m12";
  if (daysLeft <= EXPIRY_TIER_DAYS.m18) return "m18";
  if (daysLeft <= EXPIRY_TIER_DAYS.m24) return "m24";
  return "rest";
}

export async function listExpiryBatches(
  query: { q?: string; bucket?: string; warehouseId?: number; brand?: string; page?: number; pageSize?: number },
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
  const rawAllPeriods: {
    id: number; skuId: number; skuCode: string; skuName: string; brand: string | null;
    warehouse: string; warehouseId: number; stocktakeDate: string;
    batchNo: string | null; productionDate: string | null; expiryDate: string; qty: string;
  }[] = await db
    .select({
      id: bs.id,
      skuId: bs.skuId,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      brand: schema.brands.nameCn,
      warehouse: schema.warehouses.name,
      warehouseId: bs.warehouseId,
      stocktakeDate: bs.stocktakeDate,
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
  // 盘点期间收口（core/stock-view 唯一权威）：batch_stocks 唯一键含 stocktake_date，两期并存时
  // 每个段位的批次数与数量都按期数翻倍。逐仓取该仓最新一期，且用整表权威期（仓库筛选后本批 rows 仍是整仓，
  // 但与 replenish/expiry 同一写法，避免第二种收口）。
  const raw = latestStocktakeRows(rawAllPeriods, await loadLatestStocktakeDates(db));

  const all: ExpiryBatchRow[] = raw.map((r) => {
    const daysLeft = daysLeftOf(today, r.expiryDate);
    return {
      id: r.id, skuId: r.skuId, skuCode: r.skuCode, skuName: r.skuName, brand: r.brand, warehouse: r.warehouse,
      batchNo: r.batchNo, productionDate: r.productionDate, expiryDate: r.expiryDate,
      qty: num(r.qty), daysLeft, bucket: expiryBucketOf(daysLeft),
    };
  });

  const bucketCounts = emptyBuckets();
  const matrix = new Map<string, ExpiryBrandMatrixRow>();
  for (const r of all) {
    bucketCounts[r.bucket].batches++;
    bucketCounts[r.bucket].qty += r.qty;
    const brandKey = r.brand ?? EXPIRY_NO_BRAND;
    const row = matrix.get(brandKey) ?? { brand: brandKey, buckets: emptyBuckets(), batches: 0, qty: 0 };
    row.buckets[r.bucket].batches++;
    row.buckets[r.bucket].qty += r.qty;
    row.batches++;
    row.qty += r.qty;
    matrix.set(brandKey, row);
  }
  const brandMatrix = [...matrix.values()].sort((a, b) => b.qty - a.qty || a.brand.localeCompare(b.brand, "zh-CN"));
  const brand = (query.brand ?? "").trim() || null;

  let filtered = all;
  if (brand) filtered = filtered.filter((r) => (r.brand ?? EXPIRY_NO_BRAND) === brand);
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
    brandMatrix,
    brands: brandMatrix.map((r) => r.brand),
    brand,
  };
}
