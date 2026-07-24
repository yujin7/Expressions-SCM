/**
 * E6-P3 迷你 360 速览（hover 触发的高频只读接口）。
 *
 * 设计约束：**轻**——全站几十处 SKU 编码链接悬停即调，故只做单 SKU 的小查询集合
 * （主档 1 + 实时账 1 + 快照 1 + 月销 2 + 效期 1 + 参数 1 + core/supply 内部若干），
 * 不分页、不扫全表、不做建议判定。重口径一律复用唯一权威模块，禁止本地重实现：
 * - 「未结供给」= core/supply.ts 的 getOpenSupplyLines + summarizeSupply（唯一定义）；
 * - 「近 N 月 / 日均销」= core/velocity.ts 的 lastMonths + dailyFromWindow（唯一口径，除数 91）；
 * - 「全网在库」= Σstock_balances + 各仓最新快照（照抄 replenish/service.ts 的 latestSnapshotRows 模式）；
 * - 「效期」= batch_stocks 参考层（非账本），取最短剩余天数（可为负 = 已过期）。
 * 全表无金额字段，免脱敏；只读不写库。
 */
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError, todayShanghai } from "./common";
import { dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { getOpenSupplyLines, summarizeSupply } from "@/server/core/supply";
import { num, r1 } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** 日界差（Asia/Shanghai 日期字符串直减，与 report/risk.ts、replenish/expiry.ts 同准） */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export interface SkuBrief {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  skuType: string;
  lifecycle: string | null;
  active: boolean;
  /** 全网在库 = Σstock_balances + 各仓最新快照 */
  onHand: number;
  /** 近 3 月日均销（core/velocity 唯一口径，除数 91） */
  daily: number;
  /** 可销天数 = 在库 / 日均；无动销（日均=0）→ null */
  daysCover: number | null;
  /** 生产周期（sku_params.normalLeadDays）；未维护 = null */
  leadDays: number | null;
  /** 最短剩余效期天数（负 = 已过期）；无带效期批次 = null */
  minDaysLeft: number | null;
  /** 未结供给合计（core/supply 口径：po + wo + legacy_fg，不含在订未出） */
  openSupply: number;
  /** 近 6 月销量迷你序列（升序，缺月补 0） */
  spark: { ym: string; qty: number }[];
}

/**
 * 单 SKU 轻量摘要。skuCodeOrId 传编码或数字 id（数字优先按 id 命中，未命中回退编码）。
 * 不存在 → ApiError(404)。
 */
export async function getSkuBrief(skuCodeOrId: string | number, dbArg?: AnyDb): Promise<SkuBrief> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const raw = String(skuCodeOrId ?? "").trim();
  if (!raw) throw new ApiError(400, "缺少 SKU 编码或 ID");
  const today = todayShanghai();

  /* ── 主档（编码或 id 定位；brandId 为应用层外键，leftJoin 取品牌中文名） ── */
  const sel = {
    id: schema.skus.id,
    code: schema.skus.code,
    name: schema.skus.name,
    brand: schema.brands.nameCn,
    baseUom: schema.skus.baseUom,
    skuType: schema.skus.skuType,
    lifecycle: schema.skus.lifecycle,
    active: schema.skus.active,
  };
  const asId = /^\d+$/.test(raw) ? Number(raw) : null;
  let skuRows: {
    id: number;
    code: string;
    name: string;
    brand: string | null;
    baseUom: string;
    skuType: string;
    lifecycle: string | null;
    active: boolean;
  }[] = [];
  if (asId != null) {
    skuRows = await db
      .select(sel)
      .from(schema.skus)
      .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
      .where(eq(schema.skus.id, asId))
      .limit(1);
  }
  if (skuRows.length === 0) {
    skuRows = await db
      .select(sel)
      .from(schema.skus)
      .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
      .where(eq(schema.skus.code, raw))
      .limit(1);
  }
  if (skuRows.length === 0) throw new ApiError(404, `SKU 不存在：${raw}`);
  const sku = skuRows[0];
  const skuId = sku.id;

  /* ── 在库：实时账 + 各仓最新快照（旧快照不计——同 replenish/service.ts latestSnapshotRows） ── */
  const balRows: { qty: string | null }[] = await db
    .select({ qty: sql<string | null>`sum(${schema.stockBalances.qty})` })
    .from(schema.stockBalances)
    .where(eq(schema.stockBalances.skuId, skuId));
  let onHand = num(balRows[0]?.qty);
  const s = schema.stockSnapshots;
  const latest = db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, maxDate: sql<string>`max(${s.bizDate})`.as("max_date") })
    .from(s)
    .where(eq(s.skuId, skuId))
    .groupBy(s.warehouseId, s.skuId)
    .as("latest");
  const snapRows: { qty: string }[] = await db
    .select({ qty: s.qty })
    .from(s)
    .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)));
  for (const r of snapRows) onHand += num(r.qty);

  /* ── 销速与迷你曲线：core/velocity 唯一口径（最新月回推；3 月窗口 ÷91） ── */
  const sm = schema.salesMonthly;
  const maxRows: { maxYm: string | null }[] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const maxYm = maxRows[0]?.maxYm ?? null;
  const months6 = maxYm ? lastMonths(maxYm, 6) : [];
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const salesRows: { ym: string; qty: string | null }[] = months6.length
    ? await db
        .select({ ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
        .from(sm)
        .where(and(eq(sm.skuId, skuId), inArray(sm.yearMonth, months6)))
        .groupBy(sm.yearMonth)
    : [];
  const qtyByYm = new Map<string, number>(salesRows.map((r) => [r.ym, num(r.qty)]));
  const spark = months6.map((ym) => ({ ym, qty: r1(qtyByYm.get(ym) ?? 0) })); // lastMonths 已升序
  const window3 = months3.reduce((acc, ym) => acc + (qtyByYm.get(ym) ?? 0), 0);
  const daily = dailyFromWindow(window3);
  const daysCover = daily > 0 ? onHand / daily : null;

  /* ── 生产周期 ── */
  const paramRows: { normalLeadDays: number | null }[] = await db
    .select({ normalLeadDays: schema.skuParams.normalLeadDays })
    .from(schema.skuParams)
    .where(eq(schema.skuParams.skuId, skuId))
    .limit(1);
  const leadDays = paramRows[0]?.normalLeadDays ?? null;

  /* ── 效期：batch_stocks 参考层最短剩余天数（qty>0 且有效期） ── */
  const bs = schema.batchStocks;
  const batchRows: { expiryDate: string }[] = await db
    .select({ expiryDate: bs.expiryDate })
    .from(bs)
    .where(and(eq(bs.skuId, skuId), isNotNull(bs.expiryDate), gt(bs.qty, "0")));
  let minDaysLeft: number | null = null;
  for (const r of batchRows) {
    const d = daysBetween(today, r.expiryDate);
    if (minDaysLeft == null || d < minDaysLeft) minDaysLeft = d;
  }

  /* ── 未结供给：core/supply 唯一定义（禁止本地重实现四段 join） ── */
  const supplyLines = await getOpenSupplyLines(db, [skuId]);
  const openSupply = summarizeSupply(supplyLines).get(skuId)?.total ?? 0;

  return {
    skuId,
    code: sku.code,
    name: sku.name,
    brand: sku.brand,
    baseUom: sku.baseUom,
    skuType: sku.skuType,
    lifecycle: sku.lifecycle,
    active: sku.active,
    onHand: r1(onHand),
    daily: r1(daily),
    daysCover: daysCover == null ? null : r1(daysCover),
    leadDays,
    minDaysLeft,
    openSupply: r1(openSupply),
    spark,
  };
}
