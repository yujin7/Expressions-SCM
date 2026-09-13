/**
 * R15 临期/过期批次检查（v1 = 提示告警，不拦截过账）。
 *
 * 数据源：batch_stocks 批次库存参考层（非账本，效期盘点载体）——与驾驶舱效期段位同源。
 * 口径：
 * - **盘点期间收口**：batch_stocks 唯一键含 stocktake_date，同一批实物在每个盘点期间各有一行；
 *   逐仓只取该仓最新盘点期（core/stock-view.latestStocktakeRows），否则两期并存时临期量直接翻倍；
 * - 阈值 = skus.nearExpiryDays ?? 90（逐 SKU 覆盖）；
 * - 近效期 nearQty/nearBatches = expiryDate 非空、qty>0 且 剩余天数 ≤ 阈值 的批次合计（含已过期）；
 * - 已过期 expiredQty = 其中 剩余天数 ≤ 0 的小计（与驾驶舱「已到期」段位同边界）；
 * - minDaysLeft = 命中批次的最短剩余天数（可为负）；无命中为 null；
 * - 日界 Asia/Shanghai（todayShanghai）。
 * 无金额字段，免脱敏；只读，不写库。
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { batchStocks, skus } from "@/db/schema";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { dAdd } from "@/server/core/decimal";
import { daysLeftOf, latestStocktakeRows, loadLatestStocktakeDates } from "@/server/core/stock-view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const DEFAULT_NEAR_EXPIRY_DAYS = 90;

export interface ExpiryCheckItem {
  skuId: number;
  skuCode: string;
  /** 生效的临期阈值（天） */
  thresholdDays: number;
  /** 近效期合计（含已过期），批次参考层数量 */
  nearQty: number;
  nearBatches: number;
  /** 其中已过期小计 */
  expiredQty: number;
  /** 命中批次最短剩余天数（可为负=已过期天数）；无命中 null */
  minDaysLeft: number | null;
  skuKnown: boolean;
  baseUom: string | null;
  /** 当前盘点期是否观察到该 SKU；缺行不能解释为零库存。 */
  referenceRows: number;
  undatedPositiveRows: number;
  stocktakeDates: string[];
  /** 保留有符号年龄，未来盘点日期不得伪装成今天。 */
  stocktakeAgeDays: number | null;
  nearQtyExact: string;
  expiredQtyExact: string;
}

export interface ExpiryCheckResult {
  source: "batch_stock_reference";
  today: string;
  warehouseId: number | null;
  items: ExpiryCheckItem[];
}

/**
 * 命中盘点期收口后的批次行（唯一取数口径）——`expiryCheck` 与临期净额（W2-#2）共用。
 *
 * 抽出来的理由：补货引擎要按批次逐条做 FEFO 净额，不能只拿聚合后的 nearQty；
 * 若在 service 里另写一段 batch_stocks 取数，「盘点期收口」这条会立刻分叉成两份口径
 * （两期并存时临期量直接翻倍，正是本模块开头警告的那个坑）。
 */
export interface ExpiryBatchRow {
  skuId: number;
  expiryDate: string;
  qty: number;
  /** 距到期天数（可为负 = 已过期） */
  daysLeft: number;
  /** 该行所属的盘点期（batch_stocks.stocktake_date）——批次参考层的**观测时点** */
  stocktakeDate: string;
  /**
   * 观测时点距今天数（0 = 今天盘的）。
   *
   * C4 事故：本函数逐仓只取「最新盘点期」，但**多久之前的最新**不作数——
   * 6/30 盘出的 6,000 件（8/15 到期）会被当成今天还在库上，
   * 与今天账面的 800 件（另一批新货）净额相减后 availableOnHand=0，
   * 于是给一个库存充足的 SKU 开出整轮补货。参考层的鲜度必须跟着数量一起给出来，
   * 由消费方（replenish/service）按 `expiry_netting_max_stocktake_age_days` 判断还能不能用。
   */
  stocktakeAgeDays: number;
}

interface ExpiryObservation {
  skuId: number; warehouseId: number; stocktakeDate: string; expiryDate: string | null; qty: string;
}

async function loadExpiryObservations(
  db: AnyDb,
  skuIds: number[],
  warehouseId: number | null,
): Promise<ExpiryObservation[]> {
  const ids = [...new Set(skuIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return [];
  const conds = [inArray(batchStocks.skuId, ids)];
  if (warehouseId != null) conds.push(eq(batchStocks.warehouseId, warehouseId));
  const allPeriodRows: ExpiryObservation[] = await db
    .select({
      skuId: batchStocks.skuId,
      warehouseId: batchStocks.warehouseId,
      stocktakeDate: batchStocks.stocktakeDate,
      expiryDate: batchStocks.expiryDate,
      qty: batchStocks.qty,
    })
    .from(batchStocks)
    .where(and(...conds));
  // 多个盘点期间并存是 batch_stocks 的正常状态（唯一键含 stocktake_date）：不收口就按期数翻倍
  // 本函数按 SKU 分批被调用（inventory-alerts 每 200 个一批），所以最新盘点期必须整表取，
  // 不能从本批 rows 推断——否则该仓最新期里没有本批 SKU 时会退到旧期，各批次还会各认一个期。
  return latestStocktakeRows(allPeriodRows, await loadLatestStocktakeDates(db));
}

export async function loadExpiryBatches(
  db: AnyDb,
  skuIds: number[],
  opts?: { warehouseId?: number | null; today?: string },
): Promise<ExpiryBatchRow[]> {
  const today = opts?.today ?? todayShanghai();
  const rows = await loadExpiryObservations(db, skuIds, opts?.warehouseId ?? null);
  const out: ExpiryBatchRow[] = [];
  for (const r of rows) {
    if (!r.expiryDate) continue;
    const qty = Number(r.qty);
    if (!(qty > 0)) continue;
    out.push({
      skuId: r.skuId,
      expiryDate: r.expiryDate,
      qty,
      daysLeft: daysLeftOf(today, r.expiryDate),
      stocktakeDate: r.stocktakeDate,
      stocktakeAgeDays: Math.max(0, -daysLeftOf(today, r.stocktakeDate)),
    });
  }
  return out;
}

export async function expiryCheck(
  input: { skuIds: number[]; warehouseId?: number | null },
  dbArg?: AnyDb,
): Promise<ExpiryCheckResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const skuIds = [...new Set(input.skuIds)];
  if (skuIds.length > 200 || skuIds.some(n => !Number.isInteger(n) || n <= 0 || n > 2147483647)) {
    throw new ApiError(400, "效期检查每批最多 200 个有效 SKU，请分批查询");
  }
  const warehouseId = input.warehouseId ?? null;
  if (warehouseId !== null && (!Number.isInteger(warehouseId) || warehouseId <= 0 || warehouseId > 2147483647)) {
    throw new ApiError(400, "仓库编号无效，请重新选择仓库");
  }
  const today = todayShanghai();
  const source = "batch_stock_reference" as const;
  if (skuIds.length === 0) return { source, today, warehouseId, items: [] };

  const skuRows: { id: number; code: string; baseUom: string; nearExpiryDays: number | null }[] = await db
    .select({ id: skus.id, code: skus.code, baseUom: skus.baseUom, nearExpiryDays: skus.nearExpiryDays })
    .from(skus)
    .where(inArray(skus.id, skuIds));
  const skuById = new Map(skuRows.map((s) => [s.id, s]));

  const rows = await loadExpiryObservations(db, skuIds, warehouseId);
  const observations = new Map<number, ExpiryObservation[]>();
  for (const row of rows) {
    const group = observations.get(row.skuId) ?? [];
    group.push(row);
    observations.set(row.skuId, group);
  }

  const agg = new Map<number, { nearQty: string; nearBatches: number; expiredQty: string; minDaysLeft: number | null }>();
  for (const r of rows) {
    if (!r.expiryDate || !(Number(r.qty) > 0)) continue;
    const sku = skuById.get(r.skuId);
    if (!sku) continue;
    const threshold = sku.nearExpiryDays ?? DEFAULT_NEAR_EXPIRY_DAYS;
    const daysLeft = daysLeftOf(today, r.expiryDate);
    if (daysLeft > threshold) continue; // 新鲜批次
    const q = r.qty;
    const e = agg.get(r.skuId) ?? { nearQty: "0.0000", nearBatches: 0, expiredQty: "0.0000", minDaysLeft: null };
    e.nearQty = dAdd(e.nearQty, q);
    e.nearBatches += 1;
    if (daysLeft <= 0) e.expiredQty = dAdd(e.expiredQty, q); // 与驾驶舱「已到期」段位边界一致
    e.minDaysLeft = e.minDaysLeft == null ? daysLeft : Math.min(e.minDaysLeft, daysLeft);
    agg.set(r.skuId, e);
  }

  const items: ExpiryCheckItem[] = skuIds.map((id) => {
    const sku = skuById.get(id);
    const e = agg.get(id);
    const observed = observations.get(id) ?? [];
    const stocktakeDates = [...new Set(observed.map(r => r.stocktakeDate))].sort();
    return {
      skuId: id,
      skuCode: sku?.code ?? `#${id}`,
      thresholdDays: sku?.nearExpiryDays ?? DEFAULT_NEAR_EXPIRY_DAYS,
      nearQty: Number(e?.nearQty ?? 0),
      nearBatches: e?.nearBatches ?? 0,
      expiredQty: Number(e?.expiredQty ?? 0),
      minDaysLeft: e?.minDaysLeft ?? null,
      skuKnown: Boolean(sku),
      baseUom: sku?.baseUom ?? null,
      referenceRows: observed.length,
      undatedPositiveRows: observed.filter(r => !r.expiryDate && Number(r.qty) > 0).length,
      stocktakeDates,
      stocktakeAgeDays: stocktakeDates.length ? daysLeftOf(stocktakeDates[0], today) : null,
      nearQtyExact: e?.nearQty ?? "0.0000",
      expiredQtyExact: e?.expiredQty ?? "0.0000",
    };
  });
  return { source, today, warehouseId, items };
}
