/**
 * E5-08 物料比价（只读报表层）——「三家报价并排 + 推荐最优」。
 *
 * 与 R1 价格硬门的分工：R1 防的是「买贵了」（本次 PO 价 vs 基准价异动，逐单拦截）；
 * 本页挣的是「买对家」（同一物料多家供应商横向比，找出议价空间最大的物料）。
 *
 * ⚠️ 脱敏注意：价格属敏感字段。本服务**只在服务端聚合**，不经任何客户端计算；
 * 路由用 guardRead 拦截未登录。当前实现下「有读权限 = 可见价格」——
 * 若后续引入更细的价格权限（例如仓管/生产角色不可见采购价），**此处需接入 maskSensitive**
 * （脱敏唯一收口：各模块自己的 dto.ts，CLAUDE.md），并把 quotes[].price / bestPrice /
 * worstPrice 一并纳入遮蔽字段——注意 spreadPct 也会侧漏价差，需同时处理。
 *
 * 取价口径（与 R1 现价查询 outsource/po.ts 完全一致，避免比价页与开单页两套价）：
 * - price_lists 是**采购基准价**（基础单位未税价），不是售价；
 * - 唯一键含 effectiveDate ⇒ 同一 (SKU, 供应商) 有多条历史价，取 **effectiveDate ≤ 今天** 中
 *   effectiveDate 最大者；同日多条按 id 降序取后录入者（与 po.ts orderBy 同规则）；
 * - **未来生效价不参与比价**（今天还买不到这个价，摆进来会误导议价）；
 * - channelId（D11 渠道价）在 R1 现价查询里同样不区分，本页沿用：同 (SKU,供应商) 不论渠道
 *   一并参与「取最新」，选中哪条以 effectiveDate/id 为准。渠道价体系启用后此处需重审。
 *
 * 只保留 ≥2 家报价的 SKU：单一供应商无从比较，列出来只是噪音。
 * 排序：spreadPct 降序——价差最大 = 最有议价空间 = 最该先谈的物料排前。
 *
 * 只读：不写库、不开单、不落审计。
 */
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { dDiv, dMoney, dMul, dSub } from "@/server/core/decimal";
import { todayShanghai } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** PO 现供应商推断时排除的状态（草稿/作废不代表真在跟这家买） */
const LIVE_PO_STATUSES = ["approved", "in_progress", "completed"] as const;

export interface PriceQuote {
  supplierId: number;
  supplierName: string;
  /** 该供应商当前生效的基准价（基础单位未税，scale=2 字符串） */
  price: string;
  /** 该价格的生效日 YYYY-MM-DD */
  effectiveDate: string;
  /** 是否为本 SKU 的最低价（并列最低则同时为真） */
  isBest: boolean;
}

export interface PriceCompareRow {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  /** 各供应商当前生效价，按价格升序（最优在前） */
  quotes: PriceQuote[];
  bestPrice: string;
  worstPrice: string;
  /** 价差率 = (最高 − 最低) / 最低 × 100；最低价为 0 时记 0（无从计算比率） */
  spreadPct: number;
  /** 近期实际在跟谁买（最近一张生效 PO 的供应商名）；无 PO 记录 = null */
  currentSupplierHint: string | null;
}

export interface PriceCompareResult {
  rows: PriceCompareRow[];
  total: number;
  summary: {
    /** 可比物料数（≥2 家报价，不受分页影响） */
    skuCount: number;
    /** 平均价差率 */
    avgSpreadPct: number;
    /** 最大价差率 */
    maxSpreadPct: number;
  };
}

export interface PriceCompareQuery {
  q?: string;
  page?: number;
  pageSize?: number;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

export async function getPriceCompare(query: PriceCompareQuery, dbArg?: AnyDb): Promise<PriceCompareResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const q = (query.q ?? "").trim().toLowerCase();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(999, Math.max(1, query.pageSize ?? 20));
  const today = todayShanghai();

  /* ── 取全部已生效基准价（未来生效价不参与比价），带 SKU/供应商信息；
        排序保证「同 (sku,supplier) 首行即最新」——与 po.ts 现价查询同规则 ── */
  const priceRows: {
    skuId: number;
    supplierId: number;
    price: string;
    effectiveDate: string;
    code: string;
    name: string;
    baseUom: string;
    supplierName: string;
  }[] = await db
    .select({
      skuId: schema.priceLists.skuId,
      supplierId: schema.priceLists.supplierId,
      price: schema.priceLists.price,
      effectiveDate: schema.priceLists.effectiveDate,
      code: schema.skus.code,
      name: schema.skus.name,
      baseUom: schema.skus.baseUom,
      supplierName: schema.suppliers.name,
    })
    .from(schema.priceLists)
    .innerJoin(schema.skus, eq(schema.priceLists.skuId, schema.skus.id))
    .innerJoin(schema.suppliers, eq(schema.priceLists.supplierId, schema.suppliers.id))
    .where(and(eq(schema.skus.active, true), lte(schema.priceLists.effectiveDate, today)))
    .orderBy(
      schema.priceLists.skuId,
      schema.priceLists.supplierId,
      desc(schema.priceLists.effectiveDate),
      desc(schema.priceLists.id),
    );

  /* ── 逐 (SKU, 供应商) 取最新生效价：排序已就位，首见即最新，后续同键行是历史价直接丢弃 ── */
  interface SkuAgg {
    skuId: number;
    code: string;
    name: string;
    baseUom: string;
    quotes: Map<number, { supplierId: number; supplierName: string; price: string; effectiveDate: string }>;
  }
  const bySku = new Map<number, SkuAgg>();
  for (const r of priceRows) {
    let agg = bySku.get(r.skuId);
    if (!agg) {
      agg = { skuId: r.skuId, code: r.code, name: r.name, baseUom: r.baseUom, quotes: new Map() };
      bySku.set(r.skuId, agg);
    }
    if (agg.quotes.has(r.supplierId)) continue; // 已取过该供应商的最新价，本行是历史价
    agg.quotes.set(r.supplierId, {
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      price: dMoney(r.price),
      effectiveDate: r.effectiveDate,
    });
  }

  /* ── 只保留 ≥2 家报价的 SKU（单一供应商无从比较） ── */
  const comparable = [...bySku.values()].filter((a) => a.quotes.size >= 2);

  /* ── 现供应商提示：最近一张生效 PO 的供应商（草稿/作废不算「真在跟这家买」） ── */
  const hintBySku = new Map<number, string>();
  if (comparable.length > 0) {
    const poRows: { skuId: number; supplierName: string }[] = await db
      .select({ skuId: schema.poLines.skuId, supplierName: schema.suppliers.name })
      .from(schema.poLines)
      .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
      .innerJoin(schema.suppliers, eq(schema.poDocs.supplierId, schema.suppliers.id))
      .where(
        and(
          inArray(schema.poLines.skuId, comparable.map((a) => a.skuId)),
          inArray(schema.poDocs.status, [...LIVE_PO_STATUSES]),
        ),
      )
      .orderBy(desc(schema.poDocs.id), desc(schema.poLines.id));
    for (const r of poRows) if (!hintBySku.has(r.skuId)) hintBySku.set(r.skuId, r.supplierName);
  }

  /* ── 组行：最低/最高/价差率 ── */
  const all: PriceCompareRow[] = comparable.map((a) => {
    const quotes = [...a.quotes.values()].sort(
      (x, y) => Number(x.price) - Number(y.price) || x.supplierName.localeCompare(y.supplierName),
    );
    const bestPrice = quotes[0].price;
    const worstPrice = quotes[quotes.length - 1].price;
    // 价差率走 decimal（禁 float 中间运算）；最低价 ≤ 0 时比率无意义，记 0
    const spreadPct =
      Number(bestPrice) > 0 ? Number(dMul(dDiv(dSub(worstPrice, bestPrice, 2), bestPrice, 6), "100", 2)) : 0;
    return {
      skuId: a.skuId,
      code: a.code,
      name: a.name,
      baseUom: a.baseUom,
      quotes: quotes.map((qq) => ({ ...qq, isBest: qq.price === bestPrice })),
      bestPrice,
      worstPrice,
      spreadPct: r1(spreadPct),
      currentSupplierHint: hintBySku.get(a.skuId) ?? null,
    };
  });

  /* ── 搜索 / 排序（价差最大=最有议价空间优先）/ 分页 ── */
  let filtered = all;
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  filtered.sort((a, b) => b.spreadPct - a.spreadPct || a.code.localeCompare(b.code));

  const spreadSum = filtered.reduce((s, r) => s + r.spreadPct, 0);
  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    summary: {
      skuCount: filtered.length,
      avgSpreadPct: filtered.length > 0 ? r1(spreadSum / filtered.length) : 0,
      maxSpreadPct: filtered.length > 0 ? Math.max(...filtered.map((r) => r.spreadPct)) : 0,
    },
  };
}
