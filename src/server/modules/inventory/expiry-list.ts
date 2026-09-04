/**
 * 效期批次清单（仓库操作层——与 replenish/expiry.ts 的 SKU 级检查互补：
 * 本页给仓管逐「批次×仓库」的实物处置视图，风险处置页给 PMC 逐 SKU 的决策视图）。
 *
 * 口径：batch_stocks 参考层（非账本），qty>0 且 expiryDate 非空；
 * daysLeft = expiryDate − 今日（Asia/Shanghai，可为负）；段位与驾驶舱七段完全对齐。
 * 金额（W2-5）：单位成本走 `core/valuation.resolveUnitCosts` 唯一权威，
 * 逐行 `amount = 数量 × 单位成本`、段位小计 `amount`；`amount` ∈ SENSITIVE_FIELDS，
 * 由调用方按 canSeePrices 请求、出口再经 maskSensitive 兜底。
 * 没有金额的处置队列只能按数量排序——一箱赠品和一箱主推品在页面上一样重，这正是此前的状态。
 *
 * 2026-09-03 W2-J（BI-R3）：增 brand 筛选与「段位 × 品牌」矩阵（brandMatrix），
 * 矩阵与 bucketCounts 都在段位/搜索筛选**之前**统计（仓库筛选之后），指标 id expiryByBrand。
 *
 * W2 修复：
 *  - **成本覆盖率逐段位给**（`bucketCounts[b].covered/.batches`）。此前只有一个全局
 *    `costCoverage`（如「90.5% 已覆盖」），而一个只有 5% 批次有成本的段位照样显示一个金额小计——
 *    读者拿全局覆盖率去信一个局部小计，方向可以完全反过来。段位小计旁边必须是**该段位自己**的覆盖率。
 *  - **金额排序在服务端做**（`sort=amount`）。客户端比较器只排当前一页，而分页总数来自服务端，
 *    最贵的那批如果落在第 8 页就永远浮不上来；无成本的行显式置后，不按 ¥0 参与比较。
 */
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { todayShanghai } from "@/server/modules/master/common";
import { num } from "@/server/core/svc";
import { EXPIRY_TIER_DAYS, daysLeftOf, latestStocktakeRows, loadLatestStocktakeDates } from "@/server/core/stock-view";
import { dAdd, dCmp, dMul } from "@/server/core/decimal";
import { resolveUnitCosts } from "@/server/core/valuation";

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
  /** 该批次金额 = 数量 × 单位成本；无成本或非价格角色 → null/缺键 */
  amount?: string | null;
}

export interface ExpiryBucketStat {
  batches: number;
  qty: number;
  /** 段位金额小计（仅 withValue 时下发） */
  amount?: string;
  /**
   * 该段位内**有单位成本**的批次数（仅 withValue 时下发）。
   * `covered < batches` 时 `amount` 只是该段位的一部分——页面必须逐段位标注，
   * 不得拿全局覆盖率替代（一个 5% 覆盖的段位配一句「全局 90.5% 已覆盖」是误导）。
   */
  covered?: number;
}

export interface ExpiryBrandMatrixRow {
  brand: string;
  buckets: Record<ExpiryBucket, { batches: number; qty: number }>;
  batches: number;
  qty: number;
}

/** 排序键：剩余天数升序（缺省，最急的在前）/ 金额降序（服务端全集排序，需 withValue） */
export type ExpirySortKey = "daysLeft" | "amount";
export const EXPIRY_SORT_KEYS: readonly ExpirySortKey[] = ["daysLeft", "amount"];
export function parseExpirySort(v: string | null | undefined): ExpirySortKey {
  return (EXPIRY_SORT_KEYS as readonly string[]).includes(String(v)) ? (v as ExpirySortKey) : "daysLeft";
}

/**
 * 金额口径记号（出处守卫 `tests/report/calibre-provenance-guard.test.ts` 认它）。
 * 金额算法/覆盖率口径变化时升版。
 */
export const EXPIRY_MONEY_CALIBRE_KEY = "expiry-money/v1";

export interface ExpiryListResult {
  today: string;
  rows: ExpiryBatchRow[];
  total: number;
  bucketCounts: Record<ExpiryBucket, ExpiryBucketStat>;
  /** 成本覆盖率提示：有单位成本的批次数 / 总批次数（金额不完整时页面须标注） */
  costCoverage: { covered: number; total: number } | null;
  /** 本次实际生效的排序键（金额序在服务端全集上排完再分页；withValue=false 时回落 daysLeft） */
  sort: ExpirySortKey;
  /** 金额口径记号（withValue=false 时 null） */
  moneyCalibreKey: typeof EXPIRY_MONEY_CALIBRE_KEY | null;
  /** 段位 × 品牌矩阵（仓库筛选后、段位/搜索/品牌筛选前），按总数量降序；无品牌归「(未设品牌)」 */
  brandMatrix: ExpiryBrandMatrixRow[];
  /** 可选品牌（矩阵行名） */
  brands: string[];
  /** 当前品牌筛选（回显） */
  brand: string | null;
}

export const EXPIRY_NO_BRAND = "(未设品牌)";

const EXPIRY_BUCKETS: ExpiryBucket[] = ["expired", "m3", "m6", "m12", "m18", "m24", "rest"];
const emptyBuckets = (): Record<ExpiryBucket, ExpiryBucketStat> =>
  Object.fromEntries(EXPIRY_BUCKETS.map((b) => [b, { batches: 0, qty: 0 }])) as Record<ExpiryBucket, ExpiryBucketStat>;

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
  query: {
    q?: string; bucket?: string; warehouseId?: number; brand?: string;
    page?: number; pageSize?: number;
    /** 是否附带金额（调用方按 canSeePrices 决定）；false 时一次成本查询都不发生 */
    withValue?: boolean;
    /** 排序键；金额序必须服务端做（客户端比较器只排当前一页） */
    sort?: ExpirySortKey;
  },
  dbArg?: AnyDb,
): Promise<ExpiryListResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = todayShanghai();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();
  const sort: ExpirySortKey = query.withValue ? parseExpirySort(query.sort) : "daysLeft";

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

  const unitCosts = query.withValue
    ? await resolveUnitCosts(db, raw.map((r) => r.skuId))
    : null;
  let covered = 0;
  const all: ExpiryBatchRow[] = raw.map((r) => {
    const daysLeft = daysLeftOf(today, r.expiryDate);
    const unitCost = unitCosts?.get(r.skuId)?.unitCost ?? null;
    if (unitCost != null) covered += 1;
    return {
      id: r.id, skuId: r.skuId, skuCode: r.skuCode, skuName: r.skuName, brand: r.brand, warehouse: r.warehouse,
      batchNo: r.batchNo, productionDate: r.productionDate, expiryDate: r.expiryDate,
      qty: num(r.qty), daysLeft, bucket: expiryBucketOf(daysLeft),
      ...(query.withValue ? { amount: unitCost == null ? null : dMul(r.qty, unitCost, 2) } : {}),
    };
  });

  const bucketCounts = emptyBuckets();
  const matrix = new Map<string, ExpiryBrandMatrixRow>();
  for (const r of all) {
    bucketCounts[r.bucket].batches++;
    bucketCounts[r.bucket].qty += r.qty;
    if (query.withValue) {
      // 逐段位覆盖率：先把分母铺出来（段位有批次就有覆盖率，哪怕是 0/12）
      bucketCounts[r.bucket].covered = bucketCounts[r.bucket].covered ?? 0;
      if (r.amount != null) {
        bucketCounts[r.bucket].amount = dAdd(bucketCounts[r.bucket].amount ?? "0.00", r.amount, 2);
        bucketCounts[r.bucket].covered = (bucketCounts[r.bucket].covered ?? 0) + 1;
      }
    }
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
  const byDaysLeft = (a: ExpiryBatchRow, b: ExpiryBatchRow) => a.daysLeft - b.daysLeft || b.qty - a.qty;
  /* 金额降序：有金额的在前，无成本的整体置后（`Number(x ?? 0)` 会把「没成本」排成「零元」，
     那是数据缺口不是估值）。同额再按最急的效期排。 */
  const byAmountDesc = (a: ExpiryBatchRow, b: ExpiryBatchRow) => {
    const av = a.amount ?? null;
    const bv = b.amount ?? null;
    if (av == null && bv == null) return byDaysLeft(a, b);
    if (av == null) return 1;
    if (bv == null) return -1;
    const c = dCmp(bv, av);
    return c !== 0 ? c : byDaysLeft(a, b);
  };
  filtered.sort(sort === "amount" ? byAmountDesc : byDaysLeft);
  return {
    today,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    bucketCounts,
    costCoverage: query.withValue ? { covered, total: all.length } : null,
    sort,
    moneyCalibreKey: query.withValue ? EXPIRY_MONEY_CALIBRE_KEY : null,
    brandMatrix,
    brands: brandMatrix.map((r) => r.brand),
    brand,
  };
}
