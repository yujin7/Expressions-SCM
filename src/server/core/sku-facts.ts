/**
 * E8-01 SKU 事实服务：**一次装配**一批 SKU 的常用事实（在库 / 销速 / 未结供给 / 生产周期 / 可销天数）。
 *
 * ── 为什么需要它 ──
 * 共享层已经有唯一权威（stock-view / supply / velocity），但「把它们凑齐」这件事
 * 在 8 个模块里各写了一遍。凑装配的过程本身就会漂：
 *   · `workbench/focus.ts` 曾内联 `sum(qty) from stock_balances` 算在库，漏掉全部快照仓，
 *     首屏把 111 个断货风险报成 261（已修，见该文件注释）；
 *   · `master/sku-brief.ts` 的注释直接写着「照抄 replenish/service.ts 的 latestSnapshotRows 模式」——
 *     照抄就是第二实现，迟早分叉。
 * 唯一权威解决了「同一个数怎么算」，本模块解决「同一组数怎么凑齐」。
 *
 * ── 纪律 ──
 * 本模块**只组合、不计算**。任何一个字段都必须来自既有唯一权威，
 * 这里不允许出现新的 SQL 聚合口径。要加字段，先问它的权威在哪。
 *
 * ── 刻意不含 ABC 分层 ──
 * ABC 是**总体相对**分类（标准帕累托要按全量销额排序取累计占比），
 * 只给一批 skuIds 算不出正确的 A/B/C。它的权威是 `rules/abc.ts` + `report/segmentation.ts`，
 * 需要分层就调那边，不要在这里塞一个「按子集算」的假 ABC。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getOnHandBySku } from "@/server/core/stock-view";
import { getOpenSupplyLines, summarizeSupply } from "@/server/core/supply";
import { dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { num, r1 } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface SkuFacts {
  skuId: number;
  /** 全网在库（D20 口径：实时账 + 各快照仓最新快照）——core/stock-view */
  onHand: number;
  /** 近 3 月日均销（除数 91）——core/velocity */
  daily: number;
  /** 可销天数 = 在库 / 日均；日均 ≤0 → null（不做 0 除，也不假装是 0 天） */
  daysCover: number | null;
  /** 未结供给合计——core/supply（po + wo + legacy_fg） */
  openSupply: number;
  /** 生产周期（sku_params.normalLeadDays）；未维护 = null */
  leadDays: number | null;
  /** 近 N 月销量序列（升序，缺月补 0） */
  series: { ym: string; qty: number }[];
}

export interface SkuFactsView {
  bySku: Map<number, SkuFacts>;
  /** 在库快照时点（无快照仓 = null）——用于页面标注数据龄 */
  snapDate: string | null;
  /** 参与计算的月窗（升序，末位=最近一期） */
  months: string[];
  /** 销量数据最新月（无销量数据 = null） */
  maxYm: string | null;
}

export interface SkuFactsOptions {
  /** 限定 SKU；省略 = 全部（配合 finishedOnly 使用） */
  skuIds?: number[];
  /** 只算在售成品 */
  finishedOnly?: boolean;
  /** 月度序列长度，默认 6；日均固定取最近 3 月窗口（core/velocity 口径） */
  months?: number;
}

/**
 * 批量装配 SKU 事实。**批量是刻意的**——单 SKU 场景传 `[id]` 即可，
 * 但列表页/报表页必须能一次拿全，否则又会退化成每行一次查询。
 */
export async function getSkuFacts(db: AnyDb, opts: SkuFactsOptions = {}): Promise<SkuFactsView> {
  const { skuIds, finishedOnly } = opts;
  const monthCount = Math.max(1, Math.min(36, opts.months ?? 6));

  if (skuIds && skuIds.length === 0) {
    return { bySku: new Map(), snapDate: null, months: [], maxYm: null };
  }

  /* ── 目标 SKU 集合 ── */
  let ids = skuIds;
  if (!ids) {
    const conds = [eq(schema.skus.active, true)];
    if (finishedOnly) conds.push(eq(schema.skus.skuType, "finished"));
    const rows: { id: number }[] = await db.select({ id: schema.skus.id }).from(schema.skus).where(and(...conds));
    ids = rows.map((r) => r.id);
  }
  if (ids.length === 0) return { bySku: new Map(), snapDate: null, months: [], maxYm: null };

  /* ── 在库：core/stock-view 唯一权威（含快照仓合并与数据龄） ── */
  const onHandView = await getOnHandBySku(db, { skuIds: ids, finishedOnly });

  /* ── 月窗与销量：core/velocity 唯一口径（由数据最新月回推） ── */
  const sm = schema.salesMonthly;
  const [{ maxYm }]: { maxYm: string | null }[] = await db
    .select({ maxYm: sql<string | null>`max(${sm.yearMonth})` })
    .from(sm);
  const months = maxYm ? lastMonths(maxYm, monthCount) : [];
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];

  const salesBySku = new Map<number, Map<string, number>>();
  if (months.length > 0) {
    const rows: { skuId: number; ym: string; qty: string | null }[] = await db
      .select({ skuId: sm.skuId, ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
      .from(sm)
      .where(and(inArray(sm.skuId, ids), inArray(sm.yearMonth, months)))
      .groupBy(sm.skuId, sm.yearMonth);
    for (const r of rows) {
      let m = salesBySku.get(r.skuId);
      if (!m) { m = new Map(); salesBySku.set(r.skuId, m); }
      m.set(r.ym, num(r.qty));
    }
  }

  /* ── 未结供给：core/supply 唯一定义 ── */
  const supplyTotals = summarizeSupply(await getOpenSupplyLines(db, ids));

  /* ── 生产周期 ── */
  const paramRows: { skuId: number; normalLeadDays: number | null }[] = await db
    .select({ skuId: schema.skuParams.skuId, normalLeadDays: schema.skuParams.normalLeadDays })
    .from(schema.skuParams)
    .where(inArray(schema.skuParams.skuId, ids));
  const leadBySku = new Map<number, number | null>(paramRows.map((r) => [r.skuId, r.normalLeadDays]));

  /* ── 装配 ── */
  const bySku = new Map<number, SkuFacts>();
  for (const id of ids) {
    const byYm = salesBySku.get(id);
    const series = months.map((ym) => ({ ym, qty: r1(byYm?.get(ym) ?? 0) }));
    const window3 = months3.reduce((acc, ym) => acc + (byYm?.get(ym) ?? 0), 0);
    const daily = dailyFromWindow(window3);
    const onHand = num(onHandView.bySku.get(id));
    bySku.set(id, {
      skuId: id,
      onHand: r1(onHand),
      daily: r1(daily),
      daysCover: daily > 0 ? r1(onHand / daily) : null,
      openSupply: r1(supplyTotals.get(id)?.total ?? 0),
      leadDays: leadBySku.get(id) ?? null,
      series,
    });
  }

  return { bySku, snapDate: onHandView.snapDate, months, maxYm };
}

/** 单 SKU 便捷入口——内部仍走批量实现，避免出现第二套装配 */
export async function getSkuFactsFor(db: AnyDb, skuId: number, months?: number): Promise<SkuFacts | null> {
  const v = await getSkuFacts(db, { skuIds: [skuId], months });
  return v.bySku.get(skuId) ?? null;
}
