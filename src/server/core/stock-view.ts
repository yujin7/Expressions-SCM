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
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd } from "@/server/core/decimal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  /* ── 快照仓最新快照（(wh,sku) 取 max(bizDate)） ── */
  const s = schema.stockSnapshots;
  let latestQ = db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, maxDate: sql<string>`max(${s.bizDate})`.as("max_date") })
    .from(s);
  if (skuIds) latestQ = latestQ.where(inArray(s.skuId, skuIds));
  const latest = latestQ.groupBy(s.warehouseId, s.skuId).as("latest");

  let snapQ = db
    .select({ skuId: s.skuId, qty: s.qty, bizDate: s.bizDate })
    .from(s)
    .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)));
  if (finishedOnly) {
    snapQ = snapQ
      .innerJoin(schema.skus, eq(s.skuId, schema.skus.id))
      .where(and(eq(schema.skus.skuType, "finished"), eq(schema.skus.active, true)));
  }
  const snapRows: { skuId: number; qty: string; bizDate: string }[] = await snapQ;

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

/** 效期剩余天数（Asia/Shanghai 日界，日期串直减；可为负=已过期） */
export function daysLeftOf(today: string, expiryDate: string): number {
  return Math.round((Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
