/**
 * 在库口径唯一权威（Wave HH——终结「实时账+最新快照」在 12 个模块各写一遍、
 * 「取最新快照」子查询 9 份逐字复制的重复；口径修正从改 12 处变成改 1 处）。
 *
 * 口径（D20 全网在库，与驾驶舱/补货/风险历史一致）：
 *   onHand(sku) = Σ stock_balances.qty（实时记账仓）
 *               + Σ 各快照仓该 SKU 的**最新一期**快照 qty
 * 快照按 (warehouseId, skuId) 取 max(bizDate)——快照仓无流水，只有期末数。
 *
 * 返回 decimal 字符串（不丢精度）；展示层自行 Number()。
 * 注意：本模块只读，不参与过账；过账仍只经 posting/registry。
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd } from "@/server/core/decimal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface OnHandOptions {
  /** 限定 SKU 集合（不传=全部） */
  skuIds?: number[];
  /** 只算成品（join skus.skuType='finished' 且 active） */
  finishedOnly?: boolean;
}

export interface OnHandView {
  /** skuId → 在库量（decimal 字符串） */
  bySku: Map<number, string>;
  /** 参与计算的最新快照日期（无快照 = null）——页面标注数据时点用 */
  snapDate: string | null;
}

/** 快照仓「每 (仓,SKU) 最新一期」原始行——唯一实现。
 *  消费方按需自行聚合：按 SKU 汇总（getOnHandBySku）、按仓分布（驾驶舱）、单 SKU 明细（全景）。
 *  `asOf`（YYYY-MM-DD）限定"截至某日的最新一期"——回看类任务（告警结果核验、抑制复核）
 *  要的是**当时**那个在库口径，不是今天的。 */
export async function getLatestSnapshotRows(
  db: AnyDb,
  opts: { skuIds?: number[]; finishedOnly?: boolean; asOf?: string } = {},
): Promise<{ warehouseId: number; skuId: number; qty: string; bizDate: string }[]> {
  const s = schema.stockSnapshots;
  let latestQ = db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, maxDate: sql<string>`max(${s.bizDate})`.as("max_date") })
    .from(s);
  const latestConds = [
    ...(opts.skuIds ? [inArray(s.skuId, opts.skuIds)] : []),
    ...(opts.asOf ? [lte(s.bizDate, opts.asOf)] : []),
  ];
  if (latestConds.length) latestQ = latestQ.where(and(...latestConds));
  const latest = latestQ.groupBy(s.warehouseId, s.skuId).as("latest");

  let q = db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, qty: s.qty, bizDate: s.bizDate })
    .from(s)
    .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)));
  if (opts.finishedOnly) {
    q = q
      .innerJoin(schema.skus, eq(s.skuId, schema.skus.id))
      .where(and(eq(schema.skus.skuType, "finished"), eq(schema.skus.active, true)));
  }
  return q;
}

/** 全网在库（实时账 + 各快照仓最新快照）——全系统唯一实现 */
export async function getOnHandBySku(db: AnyDb, opts: OnHandOptions = {}): Promise<OnHandView> {
  const { skuIds, finishedOnly } = opts;
  if (skuIds && skuIds.length === 0) return { bySku: new Map(), snapDate: null };

  /* ── 实时记账仓 ── */
  const balConds = [];
  if (skuIds) balConds.push(inArray(schema.stockBalances.skuId, skuIds));
  if (finishedOnly) balConds.push(eq(schema.skus.skuType, "finished"), eq(schema.skus.active, true));
  let balQ = db
    .select({ skuId: schema.stockBalances.skuId, qty: sql<string | null>`sum(${schema.stockBalances.qty})` })
    .from(schema.stockBalances);
  if (finishedOnly) balQ = balQ.innerJoin(schema.skus, eq(schema.stockBalances.skuId, schema.skus.id));
  if (balConds.length) balQ = balQ.where(and(...balConds));
  const balRows: { skuId: number; qty: string | null }[] = await balQ.groupBy(schema.stockBalances.skuId);

  const bySku = new Map<number, string>();
  for (const r of balRows) bySku.set(r.skuId, r.qty ?? "0");

  /* ── 快照仓最新快照（共用原始行实现） ── */
  const snapRows = await getLatestSnapshotRows(db, { skuIds, finishedOnly });

  let snapDate: string | null = null;
  for (const r of snapRows) {
    bySku.set(r.skuId, dAdd(bySku.get(r.skuId) ?? "0", r.qty, 6));
    if (snapDate == null || r.bizDate > snapDate) snapDate = r.bizDate;
  }
  return { bySku, snapDate };
}

/** 单 SKU 在库（内部走同一实现，避免第二套口径） */
export async function getOnHandForSku(db: AnyDb, skuId: number): Promise<{ onHand: string; snapDate: string | null }> {
  const v = await getOnHandBySku(db, { skuIds: [skuId] });
  return { onHand: v.bySku.get(skuId) ?? "0", snapDate: v.snapDate };
}

/** 可销天数（日均≤0 → null，与全系统既有语义一致） */
export function coverDays(onHand: number, daily: number): number | null {
  if (daily <= 0) return null;
  return onHand / daily;
}

/**
 * 全系统「可销天数」实际有**两个**口径，同名不同义，务必按场景选对：
 *
 * | 口径 | 分子 | 用在哪 | 语义 |
 * |---|---|---|---|
 * | 在库可销 `coverDays(onHand, daily)` | 仅在库 | 风险页 / 库存分析 / 调拨 / 审批简报 / SKU事实 | 「现在手上的货能卖几天」 |
 * | 到货后可销（补货页 daysCover） | 在库 + PO在途 | replenish/service.ts | 「算上已下单在路上的能卖几天」 |
 *
 * 两者相差一个 PO 在途量。**不要把补货页的 daysCover 与其他页面的可销天数直接比大小**——
 * 今天成品 PO 在途接近 0 所以看不出差异，PO 流程一旦跑起来，补货页会系统性高于其他页。
 * 控制塔首屏的「可销 < 生产周期」已改为直接消费 replenish 的行（同源），不再自行判定。
 * 若新增第三种分子（例如含在制/含参考层），先由 `integrate-supply-chain-data`
 * 统一口径并验证所有消费者，
 * 不要再就地写一个 `x / daily`——本函数存在的意义就是让口径可数、可查、可解释。
 */

/** 效期剩余天数（Asia/Shanghai 日界，日期串直减；可为负=已过期） */
export function daysLeftOf(today: string, expiryDate: string): number {
  return Math.round((Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/**
 * 效期段位边界（天）。**唯一权威**——spec/07 N3 规定七段位，
 * spec 与 R15 裁定的边界是 0 / 92 / 183 / 365 / 548 / 730。
 *
 * 为什么必须共享：驾驶舱按 92/183 分桶，效期页却写死 90/180，
 * 于是同一批「剩余 181 天」的货在驾驶舱是「3-6月」、在效期页是「6月以上」——
 * 两个页面对同一批货给出不同段位（实测差 4 个批次 / 6 件）。
 * 边界是业务口径（KPI 风险线 ≤6月=<183d 就建立在它上面），不是各页面的展示细节。
 */
export const EXPIRY_TIER_DAYS = {
  m3: 92,
  m6: 183,
  m12: 365,
  m18: 548,
  m24: 730,
} as const;

/**
 * 批次参考层（`batch_stocks`）**盘点期间收口**——唯一权威。
 *
 * `batch_stocks` 的唯一键是 (sku, warehouse, stocktake_date, prod_date, expiry_date, batch_no)：
 * 同一批实物货在**每个盘点期间**都有独立一行，多期并存是正常状态，不是脏数据。
 * 直接把全表相加，效期量会随盘点次数成倍虚增（两期 ≈ ×2）；在调拨建议里更会因为
 * 「已过期量按多期累加后 ≥ 在库」把整仓可调拨量清零。
 *
 * 口径：**逐仓**取该仓最大的 `stocktake_date`，只保留该期的行。
 * 逐仓而不是全局——各仓盘点节奏不同，用全局最新期会把慢盘的仓整仓抹掉。
 * （原实现在 `modules/quality/service.ts` 的召回范围里，本函数即从那里提炼，两处同源。）
 */
export function latestStocktakeRows<T extends { warehouseId: number; stocktakeDate: string }>(rows: T[]): T[] {
  const latestByWarehouse = new Map<number, string>();
  for (const r of rows) {
    const cur = latestByWarehouse.get(r.warehouseId);
    if (cur == null || r.stocktakeDate > cur) latestByWarehouse.set(r.warehouseId, r.stocktakeDate);
  }
  return rows.filter((r) => latestByWarehouse.get(r.warehouseId) === r.stocktakeDate);
}
