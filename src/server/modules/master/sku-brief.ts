/**
 * E6-P3 迷你 360 速览（hover 触发的高频只读接口）。
 *
 * 设计约束：**轻**——全站几十处 SKU 编码链接悬停即调，故只做单 SKU 的小查询集合
 * （主档 1 + 实时账 1 + 快照 1 + 月销 2 + 效期 1 + 参数 1 + core/supply 内部若干），
 * 不分页、不扫全表、不做建议判定。重口径一律复用唯一权威模块，禁止本地重实现：
 * - 「在库 / 日均销 / 未结供给 / 生产周期 / 可销天数」= core/sku-facts.ts 的 getSkuFacts 一次装配
 *   （它内部再委托 stock-view / velocity / supply 三个唯一权威）。
 *   **此前这里自己写了一遍「Σstock_balances + 各仓最新快照」，注释还标着「照抄 replenish/service.ts」——
 *   照抄就是第二实现，迟早分叉；已改为调用装配层。**
 * - 「效期」= batch_stocks 参考层（非账本），取最短剩余天数（可为负 = 已过期）——参考层不进事实服务。
 * 全表无金额字段，免脱敏；只读不写库。
 */
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError, todayShanghai } from "./common";
import { getSkuFactsFor } from "@/server/core/sku-facts";
import {  r1 } from "@/server/core/svc";
import { daysLeftOf } from "@/server/core/stock-view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

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
  /** 逐 SKU 临期阈值；未维护时 90 天兜底 */
  nearExpiryDays: number;
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
    nearExpiryDays: schema.skus.nearExpiryDays,
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
    nearExpiryDays: number | null;
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

  /* ── 在库 / 销速 / 迷你曲线 / 未结供给 / 生产周期：core/sku-facts 一次装配 ── */
  const facts = await getSkuFactsFor(db, skuId, 6);
  const onHand = facts?.onHand ?? 0;
  const daily = facts?.daily ?? 0;
  const daysCover = facts?.daysCover ?? null;
  const leadDays = facts?.leadDays ?? null;
  const openSupply = facts?.openSupply ?? 0;
  const spark = facts?.series ?? [];

  /* ── 效期：batch_stocks 参考层最短剩余天数（qty>0 且有效期） ── */
  const bs = schema.batchStocks;
  const batchRows: { expiryDate: string }[] = await db
    .select({ expiryDate: bs.expiryDate })
    .from(bs)
    .where(and(eq(bs.skuId, skuId), isNotNull(bs.expiryDate), gt(bs.qty, "0")));
  let minDaysLeft: number | null = null;
  for (const r of batchRows) {
    const d = daysLeftOf(today, r.expiryDate);
    if (minDaysLeft == null || d < minDaysLeft) minDaysLeft = d;
  }

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
    nearExpiryDays: sku.nearExpiryDays ?? 90,
    openSupply: r1(openSupply),
    spark,
  };
}
