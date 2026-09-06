/**
 * 全渠道外部观察（近 30 天）：天猫 / 拼多多 / 唯品会 三个平台放到同一张表上。
 *
 * 之前决策工作室只有天猫（日销 SKU 级）。2026-09-02 把另外三条流接进来后，这里把它们
 * 按同一锚点（各自批次内最大业务日）、同一窗口（近 30 天）汇总成一眼能看的"全渠道盘子"：
 *   - 天猫：支付件数 / 支付金额 / 成功退款件数（SKU 日销 + 退款流）
 *   - 拼多多：有效订单件数（剔除已取消/退款成功；订单流 3 天滚动快照按业务键跨批次去重）
 *   - 唯品会：销售额 / 销售量（店铺×品牌日表，品牌级）
 *   - 天猫宝贝损益：真实成交、销售费用、预估毛利/净利，以及净利最高/最低的商品
 *   - /v4（2026-09-03 W2-J）：品牌归属改用数据中台「店铺档案 / 品牌档案」（shop-master / brand-master），
 *     不再靠店铺名猜品牌（店铺名猜只作档案缺失时的最后回退并计数）；输出 品牌 × 平台 矩阵；
 *     接入拼多多「商品日级 / 店铺日级」流：成交金额、成功退款、转化率与店铺日趋势（订单流仍是件数权威）。
 *
 * 全部观察口径：不与内部销量事实相加、不进入任何自动决策；缺流保持 insufficient 而不是 0。
 */
import { sql, type SQL } from "drizzle-orm";

import { dAdd, dCmp, dMoney, dQty, dSub } from "@/server/core/decimal";
import { pddDemandEligibilitySql } from "@/server/rules/pdd-demand";
import { tmallStreamsCoverSameHorizon } from "./tmall-observation-horizon";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

/** 读模型缓存键（导出：驾驶舱来源文案必须由它派生，改口径升版时文案跟着走——审计 C6） */
export const CHANNEL_OBSERVATION_CACHE_KEY = "jiandaoyun-channel-observation/v9";
const READ_MODEL_CACHE_KEY = CHANNEL_OBSERVATION_CACHE_KEY;
const WINDOW_DAYS = 30;

export interface ChannelPlatformRow {
  platform: "天猫" | "拼多多" | "唯品会";
  state: "ready" | "insufficient";
  grain: string;
  sourceAsOf: string | null;
  anchorDate: string | null;
  windowFrom: string | null;
  /** 近 30 天件数（天猫=支付件数−成功退款子订单；拼多多=有效订单件数；唯品会=销售量） */
  units: string | null;
  /** 近 30 天金额（天猫=支付金额；拼多多=无金额字段 → null；唯品会=销售额） */
  amount: string | null;
  refundUnits: string | null;
  byBrand: { brand: string; units: string; amount: string | null }[];
  byShop: { shop: string; units: string; amount: string | null }[];
  /** 品牌归属来源计数（件数口径）：已映射系统 SKU / 店铺档案 / 店铺名回退 / 未归属 */
  brandAttribution: { mappedSku: string; shopMaster: string; nameGuess: string; unattributed: string };
  gate: string;
}

export type ChannelPlatform = ChannelPlatformRow["platform"];

export interface BrandPlatformRow {
  brand: string;
  /** 各平台近 30 天件数/金额；平台缺流为 null（不补零） */
  platforms: Record<ChannelPlatform, { units: string | null; amount: string | null }>;
  totalUnits: string;
}

export interface PddShopDailyPoint {
  date: string;
  transactionAmount: string;
  refundAmount: string;
  orders: number;
  refundCount: number;
}

export interface PddProductRow {
  shopName: string;
  productId: string;
  productName: string | null;
  brand: string;
  transactionAmount30: string;
  transactionNumber30: number;
  visitors30: number;
  /** 成交人数 ÷ 访客数（%），访客为 0 时 null */
  conversion30: number | null;
}

export interface ProductPnlRow {
  shopName: string;
  platformProductId: string;
  productName: string | null;
  actualTransactionAmount: string;
  totalSalesCost: string;
  estimatedGrossProfit: string;
  estimatedNetProfit: string;
  paidNumber: string;
}

export interface TrafficProductRow {
  shopName: string;
  productId: string;
  productName: string | null;
  visitors7: number;
  visitorsPrev7: number;
  visitorDelta: number;
  paidAmount7: string;
  paidBuyers7: number;
  conversion7: number | null;
}
export interface SkuMarginRow {
  shopName: string;
  platformSkuId: string;
  relatedGoods: string | null;
  systemSkuCode: string | null;
  brand: string;
  paidAmount: string;
  refundAmount: string;
  goodsCost: string;
  margin: string;
  marginPct: number | null;
  paidNumber: number;
}
export interface ChannelObservation {
  state: "ready" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  windowDays: 30;
  platforms: ChannelPlatformRow[];
  productPnl: {
    state: "ready" | "insufficient";
    sourceAsOf: string | null;
    anchorDate: string | null;
    totals: { actualTransactionAmount: string; totalSalesCost: string; estimatedGrossProfit: string; estimatedNetProfit: string; products: number };
    topNetProfit: ProductPnlRow[];
    bottomNetProfit: ProductPnlRow[];
    gate: string;
  };
  /** 天猫商品流量先行指标（近 7 天 vs 前 7 天；数据中台「天猫商品整体」90 天时间窗） */
  traffic: {
    state: "ready" | "insufficient";
    sourceAsOf: string | null;
    anchorDate: string | null;
    totals: { visitors7: number; visitorsPrev7: number; paidAmount7: string; paidAmountPrev7: string; paidBuyers7: number; conversion7: number | null; addonPeople7: number; collections7: number; products: number };
    rising: TrafficProductRow[];
    falling: TrafficProductRow[];
    gate: string;
  };
  /** 天猫 SKU 级毛利观察（近 30 天；数据中台「SKU 销售成本核算」，货品成本口径来自源表） */
  skuMargin: {
    state: "ready" | "insufficient";
    sourceAsOf: string | null;
    anchorDate: string | null;
    totals: {
      paidAmount: string; refundAmount: string; goodsCost: string; margin: string;
      /** 只按「货品成本有值」的 SKU 计算，源表大量行成本为 0，否则毛利率会被虚高 */
      marginPct: number | null;
      skus: number; mappedSkus: number;
      /** 货品成本 > 0 的 SKU 数与其支付金额（毛利率的分母口径） */
      costCoveredSkus: number; costCoveredPaidAmount: string;
    };
    byBrand: { brand: string; paidAmount: string; margin: string; marginPct: number | null; skus: number }[];
    top: SkuMarginRow[];
    bottom: SkuMarginRow[];
    gate: string;
  };
  /** 拼多多商品日级 / 店铺日级观察（近 30 天；金额来自平台日报表，件数权威仍是订单流） */
  pddDaily: {
    state: "ready" | "insufficient";
    sourceAsOf: string | null;
    anchorDate: string | null;
    totals: {
      transactionAmount30: string; refundAmount30: string; refundCount30: number; orders30: number; buyers30: number;
      /** 店铺日级「成交转化率」按成交订单数加权的均值（%）；无数据 null */
      conversion30: number | null;
      shops: number; products: number;
    };
    byShop: { shopName: string; brand: string; transactionAmount30: string; refundAmount30: string; orders30: number; refundCount30: number }[];
    /** 全店合计日趋势（近 30 天，按日升序；缺日不补零） */
    trend: PddShopDailyPoint[];
    topProducts: PddProductRow[];
    gate: string;
  };
  /** 店铺档案 / 品牌档案（数据中台维表）覆盖情况 */
  shopMaster: {
    state: "ready" | "insufficient";
    sourceAsOf: string | null;
    shops: number;
    shopsWithBrand: number;
    brands: number;
    /** 三平台观察到、但店铺档案里没有的店铺名（最多 20 个，供业务补档案） */
    missingShops: string[];
  };
  /** 品牌 × 平台矩阵（件数按各平台口径，不相加为同一口径；总件数只作排序） */
  brandMatrix: BrandPlatformRow[];
  limitations: string[];
}
const numExpr = (field: string) =>
  `CASE WHEN trim(coalesce(payload->'data'->>'${field}','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'${field}')::numeric ELSE 0 END`;
const pctOf = (part: string, whole: string): number | null =>
  dCmp(whole, "0") > 0 ? Math.round((Number(part) / Number(whole)) * 1000) / 10 : null;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (v: unknown): string => {
  const t = v == null ? "" : String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? dMoney(t) : "0.00";
};
const qty = (v: unknown): string => {
  const t = v == null ? "" : String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? dQty(t) : "0.0000";
};
const text = (v: unknown): string | null => { const t = v == null ? "" : String(v).trim(); return t ? t : null; };

/**
 * 最新可用批次。被 supersede 的批次一律不用。qualityBlocked 的处理分三档（2026-09-03 生产实况）：
 * - 交易流（拼多多订单）：fail closed，review 批次不用；
 * - 对照表/维表（allowQualityBlocked: true）：只经 `_identity` 引用，review 不影响；
 * - 平台日快照（allowQualityBlocked: "snapshot"）：review 若只是业务键重复/缺失（源表重复上传），仍可用，
 *   读模型按业务键 DISTINCT ON 去重；数值非法、对账不符、有删除的批次仍不用。
 *   否则 85,465 行的宝贝损益会因 1 行缺键整批消失，48,885 行的 SKU 损益会因 280 行重复整批消失。
 */
async function latestBatch(
  db: ReadDb,
  stream: string,
  options: { allowQualityBlocked?: boolean | "snapshot" } = {},
): Promise<{ importJobId: number; sourceAsOf: string | null } | null> {
  const qualityFilter = options.allowQualityBlocked === true
    ? sql`true`
    : options.allowQualityBlocked === "snapshot"
      ? sql`(coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
             OR (coalesce((ir.request_scope->'controlSummary'->>'invalidNumericValues')::int, 0) = 0
                 AND coalesce((ir.request_scope->'controlSummary'->>'reconciliationMismatchedRows')::int, 0) = 0
                 AND coalesce((ir.request_scope->'controlSummary'->>'deletedRows')::int, 0) = 0))`
      : sql`coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'`;
  const result = await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream} AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND ij.status <> 'superseded'
      AND ${qualityFilter}
      AND coalesce(ir.request_scope->>'emptySource', 'false') = 'false'
    ORDER BY ir.id DESC LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  const importJobId = num(row?.import_job_id);
  return importJobId > 0 ? { importJobId, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) } : null;
}

const emptyAttribution = () => ({ mappedSku: "0.0000", shopMaster: "0.0000", nameGuess: "0.0000", unattributed: "0.0000" });

function insufficient(platform: ChannelPlatformRow["platform"], grain: string, gate: string): ChannelPlatformRow {
  return { platform, state: "insufficient", grain, sourceAsOf: null, anchorDate: null, windowFrom: null, units: null, amount: null, refundUnits: null, byBrand: [], byShop: [], brandAttribution: emptyAttribution(), gate };
}

type BrandDim = { code: string; names: string[] };
const UNATTRIBUTED = "(未归属)";

/** 店铺名 → 品牌（最后回退）：店铺名里含且仅含一个品牌名（NING / EXPRESSIONS / DEVIANCE / 爱碧生…） */
function brandOfShop(shop: string, brands: BrandDim[]): string {
  const upper = shop.toUpperCase();
  const hits = brands.filter((b) => b.names.some((n) => n.length >= 2 && upper.includes(n.toUpperCase())));
  return hits.length === 1 ? hits[0].code : UNATTRIBUTED;
}

/** 档案里的品牌名 → 系统品牌码：精确匹配 code / 中文名 / 英文名（不区分大小写）；不匹配保留档案原名 */
function normalizeBrandName(name: string, brands: BrandDim[]): string {
  const key = name.trim().toUpperCase();
  if (!key) return UNATTRIBUTED;
  const exact = brands.find((b) => b.names.some((n) => n.toUpperCase() === key));
  return exact ? exact.code : name.trim();
}

/**
 * 品牌归属器（/v4）：优先级 = 已映射系统 SKU 的品牌 → 店铺档案（shop-master，品牌名缺失时经 brand-master 补）
 * → 店铺名回退（仅档案无此店铺时）→ 未归属。每次归属记录来源，供页面显示「靠猜」的占比。
 */
interface BrandAttributor {
  attribute(shop: string, mappedBrand: string | null, units: string | number, tally: ChannelPlatformRow["brandAttribution"]): string;
  hasShop(shop: string): boolean;
  shops: number;
  shopsWithBrand: number;
  brands: number;
  sourceAsOf: string | null;
  state: "ready" | "insufficient";
}

async function loadBrandAttributor(db: ReadDb, brands: BrandDim[]): Promise<BrandAttributor> {
  const [shopBatch, brandBatch] = await Promise.all([
    latestBatch(db, "shop-master-observation", { allowQualityBlocked: true }),
    latestBatch(db, "brand-master-observation", { allowQualityBlocked: true }),
  ]);
  const brandById = new Map<string, string>();
  if (brandBatch) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      SELECT DISTINCT ON (payload->'data'->>'brandId') payload->'data'->>'brandId' AS bid, payload->'data'->>'brandName' AS bname
      FROM staging_rows WHERE import_job_id = ${brandBatch.importJobId} AND target_table = 'jdy_brand_master_observation'
        AND status IN ('pending','validated','committed') AND nullif(trim(payload->'data'->>'brandId'), '') IS NOT NULL
      ORDER BY payload->'data'->>'brandId', row_no DESC`));
    for (const r of rows) { const name = text(r.bname); if (name) brandById.set(String(r.bid).trim(), name); }
  }
  const shopBrand = new Map<string, string | null>();
  if (shopBatch) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      SELECT DISTINCT ON (payload->'data'->>'shopName') payload->'data'->>'shopName' AS shop, payload->'data'->>'brandName' AS bname, payload->'data'->>'brandId' AS bid
      FROM staging_rows WHERE import_job_id = ${shopBatch.importJobId} AND target_table = 'jdy_shop_master_observation'
        AND status IN ('pending','validated','committed') AND nullif(trim(payload->'data'->>'shopName'), '') IS NOT NULL
      ORDER BY payload->'data'->>'shopName', row_no DESC`));
    for (const r of rows) {
      const shop = String(r.shop).trim();
      const name = text(r.bname) ?? (text(r.bid) ? brandById.get(String(r.bid).trim()) ?? null : null);
      shopBrand.set(shop, name ? normalizeBrandName(name, brands) : null);
    }
  }
  return {
    state: shopBatch ? "ready" : "insufficient",
    sourceAsOf: shopBatch?.sourceAsOf ?? null,
    shops: shopBrand.size,
    shopsWithBrand: [...shopBrand.values()].filter((v) => v != null).length,
    brands: brandById.size,
    hasShop: (shop) => shopBrand.has(shop.trim()),
    attribute(shop, mappedBrand, units, tally) {
      if (mappedBrand) { tally.mappedSku = dAdd(tally.mappedSku, units, 4); return mappedBrand; }
      const key = shop.trim();
      if (shopBrand.has(key)) {
        const b = shopBrand.get(key);
        if (b) { tally.shopMaster = dAdd(tally.shopMaster, units, 4); return b; }
        tally.unattributed = dAdd(tally.unattributed, units, 4); return UNATTRIBUTED;
      }
      const guess = brandOfShop(shop, brands);
      if (guess !== UNATTRIBUTED) tally.nameGuess = dAdd(tally.nameGuess, units, 4);
      else tally.unattributed = dAdd(tally.unattributed, units, 4);
      return guess;
    },
  };
}

export async function computeChannelObservation(db: ReadDb): Promise<ChannelObservation> {
  const [tmallSales, tmallRefunds, crosswalkBatch, pddCrosswalkBatch, vip, pnl, brandRows, trafficBatch, costBatch, pddShopDailyBatch, pddProductDailyBatch] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-refund-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "pdd-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "vip-shop-trading-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-product-pnl-observation", { allowQualityBlocked: "snapshot" }),
    db.execute(sql`SELECT code, name_cn, name_en FROM brands`),
    latestBatch(db, "tmall-product-traffic-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-cost-pnl-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "pdd-shop-daily-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "pdd-product-daily-observation", { allowQualityBlocked: "snapshot" }),
  ]);
  const brands: BrandDim[] = resultRows<Record<string, unknown>>(brandRows).map((b) => ({
    code: String(b.code ?? ""), names: [String(b.code ?? ""), text(b.name_cn) ?? "", text(b.name_en) ?? ""].filter(Boolean),
  }));
  const attributor = await loadBrandAttributor(db, brands);
  const observedShops = new Set<string>();
  const tmallHorizonReady = tmallSales && tmallRefunds
    ? await tmallStreamsCoverSameHorizon(db, tmallSales.importJobId, tmallRefunds.importJobId)
    : false;

  /* ── 天猫 ── */
  let tmall = insufficient(
    "天猫",
    "统计日 × 店铺 × 平台 SKU",
    tmallSales && tmallRefunds
      ? "天猫退款观察时点落后于销量观察，净销量保持不可用。"
      : tmallSales
        ? "缺少天猫成功退款成功批次，净销量保持不可用。"
      : "缺少天猫日销量成功批次。",
  );
  // 净销量是“支付件数 − 成功退款子订单数”。两条流必须同时可用且退款观察至少覆盖销量时点；
  // 否则旧退款快照会把新日期的未知退款误当成 0。
  if (tmallSales && tmallRefunds && tmallHorizonReady) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH s_versions AS (
        SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10))
               nullif(trim(payload->>'sourceDeletedAt'), '') AS deleted_at,
               payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku, left(payload->'data'->>'statisticalDate', 10)::date AS d,
               CASE WHEN trim(coalesce(payload->'data'->>'paidNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'paidNumber')::numeric ELSE 0 END AS paid,
               CASE WHEN trim(coalesce(payload->'data'->>'paidAmount','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'paidAmount')::numeric ELSE 0 END AS amt
        FROM staging_rows WHERE import_job_id = ${tmallSales.importJobId} AND target_table = 'jdy_tmall_sku_sales_observation'
          AND status IN ('pending','validated','committed')
          AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ORDER BY payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
      ),
      s AS (SELECT * FROM s_versions WHERE deleted_at IS NULL),
      r_versions AS (
        SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10))
               nullif(trim(payload->>'sourceDeletedAt'), '') AS deleted_at,
               payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku, left(payload->'data'->>'statisticalDate', 10)::date AS d,
               CASE WHEN trim(coalesce(payload->'data'->>'successRefundSuborderNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'successRefundSuborderNumber')::numeric ELSE 0 END AS refund
        FROM staging_rows WHERE import_job_id = ${tmallRefunds.importJobId} AND target_table = 'jdy_tmall_sku_refund_observation'
          AND status IN ('pending','validated','committed')
          AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ORDER BY payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
      ),
      r AS (SELECT * FROM r_versions WHERE deleted_at IS NULL),
      a AS (SELECT max(d) AS d FROM s),
      cw AS (
        SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'platformSkuId' AS psku,
               max((payload->'_identity'->>'skuId')::int) AS sku_id,
               count(DISTINCT payload->'_identity'->>'skuId') AS n
        FROM staging_rows WHERE import_job_id = ${crosswalkBatch?.importJobId ?? -1} AND target_table = 'jdy_tmall_sku_crosswalk_observation'
          AND status IN ('pending','validated','committed')
          AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL
          AND payload->'_identity'->>'skuId' IS NOT NULL
        GROUP BY 1, 2
      ),
      direct AS (
        SELECT split_part(value, '|', 1) AS shop, split_part(value, '|', 2) AS psku, sku_id
        FROM sku_identifiers WHERE kind = 'external' AND scope = 'JIANDAOYUN:TMALL' AND active = true
      ),
      map AS (
        SELECT coalesce(cw.shop, d.shop) AS shop, coalesce(cw.psku, d.psku) AS psku,
               CASE WHEN cw.n = 1 THEN cw.sku_id WHEN cw.n IS NULL THEN d.sku_id ELSE NULL END AS sku_id
        FROM cw FULL JOIN direct d ON d.shop = cw.shop AND d.psku = cw.psku
      ),
      sb AS (
        SELECT s.shop, coalesce(b.code, '') AS brand, s.paid, s.amt
        FROM s CROSS JOIN a
        LEFT JOIN map m ON m.shop = s.shop AND m.psku = s.psku
        LEFT JOIN skus k ON k.id = m.sku_id
        LEFT JOIN brands b ON b.id = k.brand_id
        WHERE s.d > a.d - ${WINDOW_DAYS}::int
      )
      SELECT 'anchor' AS kind, a.d::text AS shop, NULL::text AS brand, NULL::numeric AS paid, NULL::numeric AS amt, NULL::numeric AS refund FROM a
      UNION ALL
      SELECT 'shop', sb.shop, sb.brand, sum(sb.paid), sum(sb.amt), 0 FROM sb GROUP BY sb.shop, sb.brand
      UNION ALL
      SELECT 'refund', r.shop, coalesce(b.code, ''), 0, 0, sum(r.refund)
      FROM r CROSS JOIN a
      LEFT JOIN map m ON m.shop = r.shop AND m.psku = r.psku
      LEFT JOIN skus k ON k.id = m.sku_id
      LEFT JOIN brands b ON b.id = k.brand_id
      WHERE r.d > a.d - ${WINDOW_DAYS}::int AND r.d <= a.d GROUP BY r.shop, coalesce(b.code, '')
    `));
    const anchor = rows.find((x) => x.kind === "anchor")?.shop ? String(rows.find((x) => x.kind === "anchor")!.shop) : null;
    const byShop = new Map<string, { units: string; amount: string; refund: string }>();
    const byBrand = new Map<string, { units: string; amount: string }>();
    const tally = emptyAttribution();
    let units = "0.0000", refund = "0.0000", amount = "0.00";
    for (const x of rows) {
      if (x.kind === "anchor") continue;
      const shop = String(x.shop ?? "");
      observedShops.add(shop);
      const cur = byShop.get(shop) ?? { units: "0.0000", amount: "0.00", refund: "0.0000" };
      cur.units = dAdd(cur.units, qty(x.paid), 4); cur.amount = dAdd(cur.amount, money(x.amt), 2); cur.refund = dAdd(cur.refund, qty(x.refund), 4);
      byShop.set(shop, cur);
      if (x.kind === "shop") {
        // 已映射的平台 SKU 用系统 SKU 的品牌；未映射按店铺档案归属，档案缺失才回退店名
        const brand = attributor.attribute(shop, text(x.brand), qty(x.paid), tally);
        const b = byBrand.get(brand) ?? { units: "0.0000", amount: "0.00" };
        b.units = dAdd(b.units, qty(x.paid), 4); b.amount = dAdd(b.amount, money(x.amt), 2); byBrand.set(brand, b);
        units = dAdd(units, qty(x.paid), 4); amount = dAdd(amount, money(x.amt), 2);
      } else if (x.kind === "refund") {
        refund = dAdd(refund, qty(x.refund), 4); units = dSub(units, qty(x.refund), 4);
        const brand = attributor.attribute(shop, text(x.brand), dSub("0", qty(x.refund), 4), tally);
        const b = byBrand.get(brand) ?? { units: "0.0000", amount: "0.00" };
        b.units = dSub(b.units, qty(x.refund), 4); byBrand.set(brand, b);
      }
    }
    tmall = {
      platform: "天猫", state: anchor ? "ready" : "insufficient", grain: "统计日 × 店铺 × 平台 SKU",
      sourceAsOf: tmallSales.sourceAsOf, anchorDate: anchor, windowFrom: anchor ? shiftDate(anchor, -(WINDOW_DAYS - 1)) : null,
      units, amount, refundUnits: refund,
      byBrand: [...byBrand.entries()].map(([brand, v]) => ({ brand, ...v })).sort((a, b) => dCmp(b.units, a.units)),
      byShop: [...byShop.entries()].map(([shop, v]) => ({ shop, units: dSub(v.units, v.refund, 4), amount: v.amount })).sort((a, b) => dCmp(b.units, a.units)),
      brandAttribution: tally,
      gate: "支付件数 − 成功退款子订单数；金额为支付金额（未扣退款与费用）。品牌按已映射系统 SKU 归属，未映射按店铺档案归属（档案缺失才按店铺名回退）。",
    };
  }

  /* ── 拼多多（订单流：最近 90 天内批次按业务键去重） ── */
  let pdd = insufficient("拼多多", "订单 × 商品 × 商家编码（3 天滚动快照去重累加）", "拼多多订单流尚未同步。");
  {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH b AS (
        SELECT ir.import_job_id,
               CASE
                 WHEN nullif(ir.request_scope->'window'->>'extractionCutoff', '') IS NULL THEN NULL
                 ELSE least(
                   nullif(ir.request_scope->'window'->>'to', '')::timestamptz,
                   nullif(ir.request_scope->'window'->>'extractionCutoff', '')::timestamptz
                 )
               END AS observed_through_at
        FROM integration_runs ir
        WHERE ir.connector = 'jdy' AND ir.stream = 'pdd-order-observation' AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
          AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
          AND ir.finished_at > now() - interval '90 days'
      ),
      o_latest AS (
        SELECT DISTINCT ON (payload->'data'->>'orderNumber', payload->'data'->>'productId', coalesce(payload->'data'->>'merchantSkuCode',''))
               payload->'data'->>'shopName' AS shop,
               payload->'data'->>'productId' AS pid,
               nullif(trim(payload->'data'->>'merchantSkuCode'), '') AS mcode,
               left(payload->'data'->>'statisticalDate', 10)::date AS d,
               CASE WHEN trim(coalesce(payload->'data'->>'productQuantity','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'productQuantity')::numeric ELSE 0 END AS qty,
               coalesce(payload->'data'->>'orderStatus','') AS status,
               coalesce(payload->'data'->>'afterSalesStatus','') AS after_sales_status,
               coalesce(payload->'data'->>'paymentTime','') AS payment_time,
               ij.source_as_of,
               payload->>'sourceDeletedAt' AS source_deleted_at
        FROM staging_rows sr INNER JOIN import_jobs ij ON ij.id = sr.import_job_id
        WHERE sr.import_job_id IN (SELECT import_job_id FROM b) AND sr.target_table = 'jdy_pdd_order_observation'
          AND sr.status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ORDER BY payload->'data'->>'orderNumber', payload->'data'->>'productId', coalesce(payload->'data'->>'merchantSkuCode',''), sr.import_job_id DESC
      ),
      -- tombstone 先压过旧版本，再被排除，防止已删除订单继续贡献销量。
      o AS (
        SELECT shop, pid, mcode, d, qty, status, after_sales_status, payment_time, source_as_of
        FROM o_latest
        WHERE nullif(trim(source_deleted_at), '') IS NULL
      ),
      cw AS (
        SELECT payload->'data'->>'shopName' AS shop,
               payload->'data'->>'platformProductId' AS pid,
               nullif(trim(payload->'data'->>'merchantSkuCode'), '') AS mcode,
               max((payload->'_identity'->>'skuId')::int) AS sku_id,
               count(DISTINCT payload->'_identity'->>'skuId') AS n
        FROM staging_rows
        WHERE import_job_id = ${pddCrosswalkBatch?.importJobId ?? -1}
          AND target_table = 'jdy_pdd_sku_crosswalk_observation'
          AND status IN ('pending','validated','committed')
          AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL
          AND payload->'_identity'->>'skuId' IS NOT NULL
        GROUP BY 1, 2, 3
      ),
      direct AS (
        SELECT split_part(value, '|', 1) AS shop,
               split_part(value, '|', 2) AS pid,
               nullif(split_part(value, '|', 3), '') AS mcode,
               sku_id
        FROM sku_identifiers
        WHERE kind = 'external' AND scope = 'JIANDAOYUN:PDD' AND active = true
      ),
      identity AS (
        SELECT coalesce(cw.shop, direct.shop) AS shop,
               coalesce(cw.pid, direct.pid) AS pid,
               coalesce(cw.mcode, direct.mcode) AS mcode,
               CASE WHEN cw.n = 1 THEN cw.sku_id WHEN cw.n IS NULL THEN direct.sku_id ELSE NULL END AS sku_id
        FROM cw FULL JOIN direct
          ON direct.shop = cw.shop AND direct.pid = cw.pid AND direct.mcode IS NOT DISTINCT FROM cw.mcode
      ),
      attributed AS (
        SELECT o.shop, coalesce(br.code, '') AS brand,
               CASE WHEN ${pddDemandEligibilitySql({
                 paymentTime: sql`o.payment_time`,
                 orderStatus: sql`o.status`,
                 afterSalesStatus: sql`o.after_sales_status`,
               })} THEN o.qty ELSE 0 END AS qty,
               o.d, o.source_as_of
        FROM o
        LEFT JOIN identity i ON i.shop = o.shop AND i.pid = o.pid AND i.mcode IS NOT DISTINCT FROM o.mcode
        LEFT JOIN skus sku ON sku.id = i.sku_id
        LEFT JOIN brands br ON br.id = sku.brand_id
      ),
      -- 有效的空窗口也代表“已观察到这里”：锚点优先取实际抽取截止的中国业务日，
      -- 旧批次没有窗口元数据时才退回订单最大业务日。
      a AS (
        SELECT coalesce(
                 (SELECT max((observed_through_at + interval '8 hours')::date) FROM b),
                 max(d)
               ) AS d,
               coalesce(
                 (SELECT max(observed_through_at)::text FROM b),
                 max(source_as_of)::text
               ) AS as_of
        FROM attributed
      )
      SELECT 'anchor' AS kind, a.d::text AS shop, NULL::text AS brand, NULL::numeric AS qty, a.as_of FROM a
      UNION ALL
      SELECT 'shop', attributed.shop, attributed.brand, sum(attributed.qty), NULL
      FROM attributed CROSS JOIN a
      WHERE attributed.d > a.d - ${WINDOW_DAYS}::int AND attributed.d <= a.d
      GROUP BY attributed.shop, attributed.brand
    `));
    const anchorRow = rows.find((x) => x.kind === "anchor");
    const anchor = anchorRow?.shop ? String(anchorRow.shop) : null;
    if (anchor) {
      const byBrand = new Map<string, string>();
      let units = "0.0000";
      const byShop = new Map<string, string>();
      const tally = emptyAttribution();
      for (const x of rows) {
        if (x.kind !== "shop") continue;
        const shop = String(x.shop ?? ""); const q = qty(x.qty);
        observedShops.add(shop);
        units = dAdd(units, q, 4); byShop.set(shop, dAdd(byShop.get(shop) ?? "0.0000", q, 4));
        const b = attributor.attribute(shop, text(x.brand), q, tally);
        byBrand.set(b, dAdd(byBrand.get(b) ?? "0.0000", q, 4));
      }
      pdd = {
        platform: "拼多多", state: "ready", grain: "订单 × 商品 × 商家编码（3 天滚动快照去重累加）",
        sourceAsOf: anchorRow?.as_of ? String(anchorRow.as_of).slice(0, 10) : null, anchorDate: anchor, windowFrom: shiftDate(anchor, -(WINDOW_DAYS - 1)),
        units, amount: null, refundUnits: null,
        byBrand: [...byBrand.entries()].map(([brand, u]) => ({ brand, units: u, amount: null })).sort((a, b) => dCmp(b.units, a.units)),
        byShop: [...byShop.entries()].map(([shop, u]) => ({ shop, units: u, amount: null })).sort((a, b) => dCmp(b.units, a.units)),
        brandAttribution: tally,
        gate: "已付款有效订单件数（剔除待付款、已取消/退款成功）；订单流无金额字段。品牌优先按已映射系统 SKU 归属，未映射按店铺档案归属。窗口内批次不足 30 天时件数偏低。",
      };
    }
  }

  /* ── 拼多多商品日级 / 店铺日级（/v4：金额 / 退款 / 转化 / 店铺日趋势） ── */
  let pddDaily: ChannelObservation["pddDaily"] = {
    state: "insufficient", sourceAsOf: null, anchorDate: null,
    totals: { transactionAmount30: "0.00", refundAmount30: "0.00", refundCount30: 0, orders30: 0, buyers30: 0, conversion30: null, shops: 0, products: 0 },
    byShop: [], trend: [], topProducts: [], gate: "拼多多店铺交易日表 / 商品日表尚未同步。",
  };
  if (pddShopDailyBatch || pddProductDailyBatch) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH sd AS (
        SELECT DISTINCT ON (payload->'data'->>'shopName', left(payload->'data'->>'statisticalDate', 10))
               payload->'data'->>'shopName' AS shop, left(payload->'data'->>'statisticalDate', 10)::date AS d,
               ${sql.raw(`${numExpr("transactionAmount")} AS amt, ${numExpr("refundAmount")} AS refund_amt, ${numExpr("refundCount")} AS refund_n, ${numExpr("transactionOrders")} AS orders, ${numExpr("transactionBuyers")} AS buyers, ${numExpr("conversionRate")} AS conv`)}
        FROM staging_rows WHERE import_job_id = ${pddShopDailyBatch?.importJobId ?? -1} AND target_table = 'jdy_pdd_shop_daily_observation'
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND nullif(trim(payload->'data'->>'shopName'), '') IS NOT NULL
        ORDER BY payload->'data'->>'shopName', left(payload->'data'->>'statisticalDate', 10), row_no DESC
      ),
      pd AS (
        SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'productId', left(payload->'data'->>'statisticalDate', 10))
               payload->'data'->>'shopName' AS shop, payload->'data'->>'productId' AS pid, payload->'data'->>'productName' AS pname,
               left(payload->'data'->>'statisticalDate', 10)::date AS d,
               ${sql.raw(`${numExpr("transactionAmount")} AS amt, ${numExpr("transactionNumber")} AS n, ${numExpr("visitors")} AS v, ${numExpr("transactionBuyers")} AS buyers`)}
        FROM staging_rows WHERE import_job_id = ${pddProductDailyBatch?.importJobId ?? -1} AND target_table = 'jdy_pdd_product_daily_observation'
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND nullif(trim(payload->'data'->>'productId'), '') IS NOT NULL
        ORDER BY payload->'data'->>'shopName', payload->'data'->>'productId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
      ),
      a AS (SELECT greatest((SELECT max(d) FROM sd), (SELECT max(d) FROM pd)) AS d)
      SELECT 'anchor' AS kind, a.d::text AS k1, NULL::text AS k2, NULL::text AS k3, NULL::numeric AS amt, NULL::numeric AS refund_amt, NULL::numeric AS refund_n, NULL::numeric AS orders, NULL::numeric AS buyers, NULL::numeric AS conv, NULL::numeric AS v FROM a
      UNION ALL
      SELECT 'shop', sd.shop, NULL, NULL, sum(sd.amt), sum(sd.refund_amt), sum(sd.refund_n), sum(sd.orders), sum(sd.buyers), sum(sd.conv * sd.orders), NULL
      FROM sd CROSS JOIN a WHERE sd.d > a.d - ${WINDOW_DAYS}::int GROUP BY sd.shop
      UNION ALL
      SELECT 'day', sd.d::text, NULL, NULL, sum(sd.amt), sum(sd.refund_amt), sum(sd.refund_n), sum(sd.orders), NULL, NULL, NULL
      FROM sd CROSS JOIN a WHERE sd.d > a.d - ${WINDOW_DAYS}::int GROUP BY sd.d
      UNION ALL
      SELECT 'product', pd.shop, pd.pid, max(pd.pname), sum(pd.amt), NULL, NULL, sum(pd.n), sum(pd.buyers), NULL, sum(pd.v)
      FROM pd CROSS JOIN a WHERE pd.d > a.d - ${WINDOW_DAYS}::int GROUP BY pd.shop, pd.pid
    `));
    const anchor = text(rows.find((x) => x.kind === "anchor")?.k1);
    if (anchor) {
      const shopTally = emptyAttribution();
      const byShop = rows.filter((x) => x.kind === "shop").map((x) => {
        const shopName = String(x.k1 ?? "");
        observedShops.add(shopName);
        return {
          shopName, brand: attributor.attribute(shopName, null, num(x.orders), shopTally),
          transactionAmount30: money(x.amt), refundAmount30: money(x.refund_amt), orders30: num(x.orders), refundCount30: num(x.refund_n),
          convWeighted: num(x.conv), buyers30: num(x.buyers),
        };
      }).sort((p, q) => dCmp(q.transactionAmount30, p.transactionAmount30));
      const totals = byShop.reduce((acc, s) => ({
        transactionAmount30: dAdd(acc.transactionAmount30, s.transactionAmount30, 2), refundAmount30: dAdd(acc.refundAmount30, s.refundAmount30, 2),
        refundCount30: acc.refundCount30 + s.refundCount30, orders30: acc.orders30 + s.orders30, buyers30: acc.buyers30 + s.buyers30,
        convWeighted: acc.convWeighted + s.convWeighted,
      }), { transactionAmount30: "0.00", refundAmount30: "0.00", refundCount30: 0, orders30: 0, buyers30: 0, convWeighted: 0 });
      const productTally = emptyAttribution();
      const products: PddProductRow[] = rows.filter((x) => x.kind === "product").map((x) => {
        const shopName = String(x.k1 ?? ""); const visitors30 = num(x.v); const buyers = num(x.buyers);
        return {
          shopName, productId: String(x.k2 ?? ""), productName: text(x.k3), brand: attributor.attribute(shopName, null, num(x.orders), productTally),
          transactionAmount30: money(x.amt), transactionNumber30: num(x.orders), visitors30,
          conversion30: visitors30 > 0 ? Math.round((buyers / visitors30) * 1000) / 10 : null,
        };
      }).sort((p, q) => dCmp(q.transactionAmount30, p.transactionAmount30));
      pddDaily = {
        state: "ready", sourceAsOf: pddShopDailyBatch?.sourceAsOf ?? pddProductDailyBatch?.sourceAsOf ?? null, anchorDate: anchor,
        totals: {
          transactionAmount30: totals.transactionAmount30, refundAmount30: totals.refundAmount30, refundCount30: totals.refundCount30,
          orders30: totals.orders30, buyers30: totals.buyers30,
          conversion30: totals.orders30 > 0 ? Math.round((totals.convWeighted / totals.orders30) * 10) / 10 : null,
          shops: byShop.length, products: products.length,
        },
        byShop: byShop.map(({ convWeighted: _c, buyers30: _b, ...rest }) => rest),
        trend: rows.filter((x) => x.kind === "day").map((x) => ({
          date: String(x.k1 ?? ""), transactionAmount: money(x.amt), refundAmount: money(x.refund_amt), orders: num(x.orders), refundCount: num(x.refund_n),
        })).sort((p, q) => p.date.localeCompare(q.date)),
        topProducts: products.slice(0, 20),
        gate: "平台报表口径：店铺日级成交额 / 成功退款额（未扣退款）/ 成交转化率（按成交订单数加权）；商品日级成交额与访客；与订单流件数不是同一口径，不相加。",
      };
      // 订单流无金额：平台行的金额/退款件数改由店铺日表补足，并在 gate 里注明来源
      if (pdd.state === "ready" && pddShopDailyBatch) {
        pdd = {
          ...pdd, amount: totals.transactionAmount30, refundUnits: dQty(totals.refundCount30),
          byShop: pdd.byShop.map((s) => ({ ...s, amount: byShop.find((x) => x.shopName === s.shop)?.transactionAmount30 ?? null })),
          gate: `${pdd.gate} 金额与退款件数来自店铺交易日表（店铺日级，锚点 ${anchor}），与订单件数不是同一张表。`,
        };
      }
    }
  }

  /* ── 唯品会（店铺 × 品牌 × 日） ── */
  let vipRow = insufficient("唯品会", "统计日 × 店铺 × 品牌", "唯品会店铺交易流尚未同步。");
  if (vip) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH v AS (
        SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'brandName' AS brand, left(payload->'data'->>'statisticalDate', 10)::date AS d,
               CASE WHEN trim(coalesce(payload->'data'->>'salesQuantity','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'salesQuantity')::numeric ELSE 0 END AS qty,
               CASE WHEN trim(coalesce(payload->'data'->>'salesAmount','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'salesAmount')::numeric ELSE 0 END AS amt
        FROM staging_rows WHERE import_job_id = ${vip.importJobId} AND target_table = 'jdy_vip_shop_trading_observation'
          AND status IN ('pending','validated','committed')
          AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL
          AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ),
      a AS (SELECT max(d) AS d FROM v)
      SELECT 'anchor' AS kind, a.d::text AS shop, NULL::text AS brand, NULL::numeric AS qty, NULL::numeric AS amt FROM a
      UNION ALL
      SELECT 'row', v.shop, v.brand, sum(v.qty), sum(v.amt) FROM v CROSS JOIN a WHERE v.d > a.d - ${WINDOW_DAYS}::int GROUP BY v.shop, v.brand
    `));
    const anchor = rows.find((x) => x.kind === "anchor")?.shop ? String(rows.find((x) => x.kind === "anchor")!.shop) : null;
    if (anchor) {
      const byBrand = new Map<string, { units: string; amount: string }>();
      const byShop = new Map<string, { units: string; amount: string }>();
      const vipTally = emptyAttribution();
      let units = "0.0000", amount = "0.00";
      for (const x of rows) {
        if (x.kind !== "row") continue;
        const q = qty(x.qty); const m = money(x.amt);
        units = dAdd(units, q, 4); amount = dAdd(amount, m, 2);
        observedShops.add(String(x.shop ?? ""));
        vipTally.shopMaster = dAdd(vipTally.shopMaster, q, 4);
        const brandKey = normalizeBrandName(String(x.brand ?? ""), brands);
        const b = byBrand.get(brandKey) ?? { units: "0.0000", amount: "0.00" }; b.units = dAdd(b.units, q, 4); b.amount = dAdd(b.amount, m, 2); byBrand.set(brandKey, b);
        const s = byShop.get(String(x.shop ?? "")) ?? { units: "0.0000", amount: "0.00" }; s.units = dAdd(s.units, q, 4); s.amount = dAdd(s.amount, m, 2); byShop.set(String(x.shop ?? ""), s);
      }
      vipRow = {
        platform: "唯品会", state: "ready", grain: "统计日 × 店铺 × 品牌",
        sourceAsOf: vip.sourceAsOf, anchorDate: anchor, windowFrom: shiftDate(anchor, -(WINDOW_DAYS - 1)),
        units, amount, refundUnits: null,
        byBrand: [...byBrand.entries()].map(([brand, v]) => ({ brand, ...v })).sort((a, b) => dCmp(b.units, a.units)),
        byShop: [...byShop.entries()].map(([shop, v]) => ({ shop, ...v })).sort((a, b) => dCmp(b.units, a.units)),
        brandAttribution: vipTally,
        gate: "平台报表的销售额/销售量（品牌级，不到 SKU）；品牌为源表品牌名按系统品牌码归一。",
      };
    }
  }

  /* ── 天猫宝贝损益 ── */
  let productPnl: ChannelObservation["productPnl"] = {
    state: "insufficient", sourceAsOf: null, anchorDate: null,
    totals: { actualTransactionAmount: "0.00", totalSalesCost: "0.00", estimatedGrossProfit: "0.00", estimatedNetProfit: "0.00", products: 0 },
    topNetProfit: [], bottomNetProfit: [], gate: "天猫宝贝日汇总尚未同步。",
  };
  if (pnl) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH p AS (
        SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'platformProductId', left(payload->'data'->>'statisticalDate', 10))
               payload->'data'->>'shopName' AS shop, payload->'data'->>'platformProductId' AS pid, payload->'data'->>'productName' AS pname,
               left(payload->'data'->>'statisticalDate', 10)::date AS d,
               ${sql.raw(["actualTransactionAmount", "totalSalesCost", "estimatedGrossProfit", "estimatedNetProfit"].map((f) =>
                 `${numExpr(f)} AS ${f.toLowerCase()}`).join(", "))},
               ${sql.raw(`${numExpr("paidNumber")} AS paid`)}
        FROM staging_rows WHERE import_job_id = ${pnl.importJobId} AND target_table = 'jdy_tmall_product_pnl_observation'
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL
          AND nullif(trim(payload->'data'->>'platformProductId'), '') IS NOT NULL AND nullif(trim(payload->'data'->>'shopName'), '') IS NOT NULL
        ORDER BY payload->'data'->>'shopName', payload->'data'->>'platformProductId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
      ),
      a AS (SELECT max(d) AS d FROM p)
      SELECT 'anchor' AS kind, a.d::text AS shop, NULL::text AS pid, NULL::text AS pname, NULL::numeric AS amt, NULL::numeric AS cost, NULL::numeric AS gross, NULL::numeric AS net, NULL::numeric AS paid FROM a
      UNION ALL
      SELECT 'product', p.shop, p.pid, max(p.pname), sum(p.actualtransactionamount), sum(p.totalsalescost), sum(p.estimatedgrossprofit), sum(p.estimatednetprofit), sum(p.paid)
      FROM p CROSS JOIN a WHERE p.d > a.d - ${WINDOW_DAYS}::int GROUP BY p.shop, p.pid
    `));
    const anchor = rows.find((x) => x.kind === "anchor")?.shop ? String(rows.find((x) => x.kind === "anchor")!.shop) : null;
    const products: ProductPnlRow[] = rows.filter((x) => x.kind === "product").map((x) => ({
      shopName: String(x.shop ?? ""), platformProductId: String(x.pid ?? ""), productName: text(x.pname),
      actualTransactionAmount: money(x.amt), totalSalesCost: money(x.cost), estimatedGrossProfit: money(x.gross), estimatedNetProfit: money(x.net), paidNumber: qty(x.paid),
    }));
    const totals = products.reduce((acc, p) => ({
      actualTransactionAmount: dAdd(acc.actualTransactionAmount, p.actualTransactionAmount, 2),
      totalSalesCost: dAdd(acc.totalSalesCost, p.totalSalesCost, 2),
      estimatedGrossProfit: dAdd(acc.estimatedGrossProfit, p.estimatedGrossProfit, 2),
      estimatedNetProfit: dAdd(acc.estimatedNetProfit, p.estimatedNetProfit, 2),
      products: acc.products + 1,
    }), { actualTransactionAmount: "0.00", totalSalesCost: "0.00", estimatedGrossProfit: "0.00", estimatedNetProfit: "0.00", products: 0 });
    const sorted = [...products].sort((a, b) => dCmp(b.estimatedNetProfit, a.estimatedNetProfit));
    productPnl = {
      state: anchor && products.length ? "ready" : "insufficient",
      sourceAsOf: pnl.sourceAsOf, anchorDate: anchor,
      totals,
      topNetProfit: sorted.slice(0, 10),
      bottomNetProfit: sorted.filter((p) => dCmp(p.estimatedNetProfit, "0") < 0).slice(-10).reverse(),
      gate: "平台侧「预估毛利/净利」：含销售费用与公摊估算，不含产品成本口径校验；只作产品级损益旁证，不进财务关账。",
    };
  }

  /* ── 天猫商品流量先行指标（近 7 天 vs 前 7 天） ── */
  let traffic: ChannelObservation["traffic"] = {
    state: "insufficient", sourceAsOf: null, anchorDate: null,
    totals: { visitors7: 0, visitorsPrev7: 0, paidAmount7: "0.00", paidAmountPrev7: "0.00", paidBuyers7: 0, conversion7: null, addonPeople7: 0, collections7: 0, products: 0 },
    rising: [], falling: [], gate: "天猫商品整体（流量）尚未同步。",
  };
  if (trafficBatch) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH t AS (
        SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'productId', left(payload->'data'->>'statisticalDate', 10))
               payload->'data'->>'shopName' AS shop, payload->'data'->>'productId' AS pid, payload->'data'->>'productName' AS pname,
               left(payload->'data'->>'statisticalDate', 10)::date AS d,
               ${sql.raw(`${numExpr("visitors")} AS v, ${numExpr("paidAmount")} AS amt, ${numExpr("paidBuyers")} AS buyers, ${numExpr("addonPeople")} AS addon, ${numExpr("collections")} AS coll`)}
        FROM staging_rows WHERE import_job_id = ${trafficBatch.importJobId} AND target_table = 'jdy_tmall_product_traffic_observation'
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND nullif(trim(payload->'data'->>'productId'), '') IS NOT NULL
        ORDER BY payload->'data'->>'shopName', payload->'data'->>'productId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
      ),
      a AS (SELECT max(d) AS d FROM t)
      SELECT 'anchor' AS kind, a.d::text AS shop, NULL::text AS pid, NULL::text AS pname, NULL::numeric AS v7, NULL::numeric AS vprev, NULL::numeric AS amt7, NULL::numeric AS amtprev, NULL::numeric AS b7, NULL::numeric AS addon7, NULL::numeric AS coll7 FROM a
      UNION ALL
      SELECT 'product', t.shop, t.pid, max(t.pname),
             sum(t.v) FILTER (WHERE t.d > a.d - 7), sum(t.v) FILTER (WHERE t.d <= a.d - 7),
             sum(t.amt) FILTER (WHERE t.d > a.d - 7), sum(t.amt) FILTER (WHERE t.d <= a.d - 7),
             sum(t.buyers) FILTER (WHERE t.d > a.d - 7), sum(t.addon) FILTER (WHERE t.d > a.d - 7), sum(t.coll) FILTER (WHERE t.d > a.d - 7)
      FROM t CROSS JOIN a WHERE t.d > a.d - 14 GROUP BY t.shop, t.pid
    `));
    const anchor = rows.find((x) => x.kind === "anchor")?.shop ? String(rows.find((x) => x.kind === "anchor")!.shop) : null;
    const products: TrafficProductRow[] = rows.filter((x) => x.kind === "product").map((x) => {
      const visitors7 = num(x.v7), visitorsPrev7 = num(x.vprev), paidBuyers7 = num(x.b7);
      return {
        shopName: String(x.shop ?? ""), productId: String(x.pid ?? ""), productName: text(x.pname),
        visitors7, visitorsPrev7, visitorDelta: visitors7 - visitorsPrev7,
        paidAmount7: money(x.amt7), paidBuyers7,
        conversion7: visitors7 > 0 ? Math.round((paidBuyers7 / visitors7) * 1000) / 10 : null,
      };
    });
    const totals = products.reduce((acc, r, i) => ({
      visitors7: acc.visitors7 + r.visitors7, visitorsPrev7: acc.visitorsPrev7 + r.visitorsPrev7,
      paidAmount7: dAdd(acc.paidAmount7, r.paidAmount7, 2), paidAmountPrev7: dAdd(acc.paidAmountPrev7, money(rows.filter((x) => x.kind === "product")[i]?.amtprev), 2),
      paidBuyers7: acc.paidBuyers7 + r.paidBuyers7, conversion7: null as number | null,
      addonPeople7: acc.addonPeople7 + num(rows.filter((x) => x.kind === "product")[i]?.addon7), collections7: acc.collections7 + num(rows.filter((x) => x.kind === "product")[i]?.coll7),
      products: acc.products + 1,
    }), { visitors7: 0, visitorsPrev7: 0, paidAmount7: "0.00", paidAmountPrev7: "0.00", paidBuyers7: 0, conversion7: null as number | null, addonPeople7: 0, collections7: 0, products: 0 });
    totals.conversion7 = totals.visitors7 > 0 ? Math.round((totals.paidBuyers7 / totals.visitors7) * 1000) / 10 : null;
    const byDelta = [...products].sort((a, b) => b.visitorDelta - a.visitorDelta || dCmp(b.paidAmount7, a.paidAmount7));
    traffic = {
      state: anchor && products.length ? "ready" : "insufficient",
      sourceAsOf: trafficBatch.sourceAsOf, anchorDate: anchor, totals,
      rising: byDelta.filter((r) => r.visitorDelta > 0).slice(0, 10),
      falling: byDelta.filter((r) => r.visitorDelta < 0).slice(-10).reverse(),
      gate: "平台侧商品访客/支付买家/加购/收藏（宝贝级，不到 SKU）；近 7 天与其前 7 天对比只是先行信号，不进入销速或补货。",
    };
  }
  /* ── 天猫 SKU 级毛利观察（近 30 天） ── */
  let skuMargin: ChannelObservation["skuMargin"] = {
    state: "insufficient", sourceAsOf: null, anchorDate: null,
    totals: { paidAmount: "0.00", refundAmount: "0.00", goodsCost: "0.00", margin: "0.00", marginPct: null, skus: 0, mappedSkus: 0, costCoveredSkus: 0, costCoveredPaidAmount: "0.00" },
    byBrand: [], top: [], bottom: [], gate: "天猫 SKU 销售成本核算尚未同步。",
  };
  if (costBatch) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH c AS (
        SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10))
               payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku, nullif(trim(payload->'data'->>'relatedGoods'), '') AS rg,
               left(payload->'data'->>'statisticalDate', 10)::date AS d,
               ${sql.raw(`${numExpr("paidAmount")} AS paid, ${numExpr("refundAmount")} AS refund, ${numExpr("goodsCostSubtotal")} AS cost, ${numExpr("paidNumber")} AS n`)}
        FROM staging_rows WHERE import_job_id = ${costBatch.importJobId} AND target_table = 'jdy_tmall_sku_cost_pnl_observation'
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND nullif(trim(payload->'data'->>'skuId'), '') IS NOT NULL
        ORDER BY payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
      ),
      a AS (SELECT max(d) AS d FROM c)
      SELECT 'anchor' AS kind, a.d::text AS shop, NULL::text AS psku, NULL::text AS rg, NULL::text AS code, NULL::text AS brand, NULL::numeric AS paid, NULL::numeric AS refund, NULL::numeric AS cost, NULL::numeric AS n FROM a
      UNION ALL
      SELECT 'sku', c.shop, c.psku, max(c.rg), k.code, coalesce(b.code, '(未归属)'), sum(c.paid), sum(c.refund), sum(c.cost), sum(c.n)
      FROM c CROSS JOIN a
      LEFT JOIN skus k ON k.code = c.rg AND k.active = true
      LEFT JOIN brands b ON b.id = k.brand_id
      WHERE c.d > a.d - ${WINDOW_DAYS}::int
      GROUP BY c.shop, c.psku, k.code, b.code
    `));
    const anchor = rows.find((x) => x.kind === "anchor")?.shop ? String(rows.find((x) => x.kind === "anchor")!.shop) : null;
    const skus: SkuMarginRow[] = rows.filter((x) => x.kind === "sku").map((x) => {
      const paidAmount = money(x.paid), refundAmount = money(x.refund), goodsCost = money(x.cost);
      const margin = dSub(dSub(paidAmount, refundAmount, 2), goodsCost, 2);
      return {
        shopName: String(x.shop ?? ""), platformSkuId: String(x.psku ?? ""), relatedGoods: text(x.rg), systemSkuCode: text(x.code),
        brand: String(x.brand ?? "(未归属)"), paidAmount, refundAmount, goodsCost, margin,
        marginPct: pctOf(margin, dSub(paidAmount, refundAmount, 2)), paidNumber: num(x.n),
      };
    });
    const hasCost = (r: SkuMarginRow) => dCmp(r.goodsCost, "0") > 0;
    const totals = skus.reduce((acc, r) => ({
      paidAmount: dAdd(acc.paidAmount, r.paidAmount, 2), refundAmount: dAdd(acc.refundAmount, r.refundAmount, 2),
      goodsCost: dAdd(acc.goodsCost, r.goodsCost, 2), margin: dAdd(acc.margin, r.margin, 2), marginPct: null as number | null,
      skus: acc.skus + 1, mappedSkus: acc.mappedSkus + (r.systemSkuCode ? 1 : 0),
      costCoveredSkus: acc.costCoveredSkus + (hasCost(r) ? 1 : 0),
      costCoveredPaidAmount: hasCost(r) ? dAdd(acc.costCoveredPaidAmount, r.paidAmount, 2) : acc.costCoveredPaidAmount,
    }), { paidAmount: "0.00", refundAmount: "0.00", goodsCost: "0.00", margin: "0.00", marginPct: null as number | null, skus: 0, mappedSkus: 0, costCoveredSkus: 0, costCoveredPaidAmount: "0.00" });
    // 毛利率只按成本有值的 SKU 算：净额 = 支付 − 退款；毛利 = 净额 − 成本
    const covered = skus.filter(hasCost);
    const coveredNet = covered.reduce((acc, r) => dAdd(acc, dSub(r.paidAmount, r.refundAmount, 2), 2), "0.00");
    const coveredMargin = covered.reduce((acc, r) => dAdd(acc, r.margin, 2), "0.00");
    totals.marginPct = pctOf(coveredMargin, coveredNet);
    const brandAgg = new Map<string, { paidAmount: string; refundAmount: string; margin: string; skus: number; coveredNet: string; coveredMargin: string }>();
    for (const r of skus) {
      const b = brandAgg.get(r.brand) ?? { paidAmount: "0.00", refundAmount: "0.00", margin: "0.00", skus: 0, coveredNet: "0.00", coveredMargin: "0.00" };
      b.paidAmount = dAdd(b.paidAmount, r.paidAmount, 2); b.refundAmount = dAdd(b.refundAmount, r.refundAmount, 2); b.margin = dAdd(b.margin, r.margin, 2); b.skus++;
      if (hasCost(r)) { b.coveredNet = dAdd(b.coveredNet, dSub(r.paidAmount, r.refundAmount, 2), 2); b.coveredMargin = dAdd(b.coveredMargin, r.margin, 2); }
      brandAgg.set(r.brand, b);
    }
    const sorted = [...skus].sort((a, b) => dCmp(b.margin, a.margin));
    skuMargin = {
      state: anchor && skus.length ? "ready" : "insufficient",
      sourceAsOf: costBatch.sourceAsOf, anchorDate: anchor, totals,
      byBrand: [...brandAgg.entries()].map(([brand, b]) => ({ brand, paidAmount: b.paidAmount, margin: b.margin, marginPct: pctOf(b.coveredMargin, b.coveredNet), skus: b.skus }))
        .sort((a, b) => dCmp(b.paidAmount, a.paidAmount)),
      top: sorted.filter(hasCost).slice(0, 10),
      bottom: sorted.filter((r) => hasCost(r) && dCmp(r.margin, "0") < 0).slice(-10).reverse(),
      gate: `毛利 = 支付金额 − 成功退款金额 − 货品成本小计（源表运营成本单价 × 件数）；成本有值的 SKU ${totals.costCoveredSkus}/${totals.skus}（支付 ¥${totals.costCoveredPaidAmount}），毛利率与榜单只按这些 SKU 计；不含平台费用与物流，品牌按「关联货品」映射到系统 SKU。只作 SKU 级损益旁证。`,
    };
  }
  const platforms = [tmall, pdd, vipRow];
  // 拼多多品牌级金额：订单流无金额，用店铺日表按店铺档案归属到品牌（与件数不是同一张表，矩阵里并列）
  const pddBrandAmount = new Map<string, string>();
  for (const s of pddDaily.byShop) pddBrandAmount.set(s.brand, dAdd(pddBrandAmount.get(s.brand) ?? "0.00", s.transactionAmount30, 2));
  const brandMatrix = buildBrandMatrix(platforms, { "拼多多": pddDaily.state === "ready" ? pddBrandAmount : null });
  const missingShops = [...observedShops].filter((s) => s && !attributor.hasShop(s)).sort().slice(0, 20);
  const guessed = platforms.reduce((acc, p) => dAdd(acc, p.brandAttribution.nameGuess.replace(/^-/, ""), 4), "0.0000");
  return {
    state: platforms.some((p) => p.state === "ready") ? "ready" : "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    windowDays: 30,
    platforms,
    productPnl,
    traffic,
    skuMargin,
    pddDaily,
    shopMaster: {
      state: attributor.state, sourceAsOf: attributor.sourceAsOf,
      shops: attributor.shops, shopsWithBrand: attributor.shopsWithBrand, brands: attributor.brands, missingShops,
    },
    brandMatrix,
    limitations: [
      "三个平台各自按自身批次的最大业务日锚定近 30 天，时点不完全对齐；件数口径也不同（天猫净件数、拼多多有效订单件数、唯品会销售量）。",
      "只是观察：不与内部 sales_monthly 相加、不进入销速/补货/关账。",
      "拼多多订单流只保留最近 90 天内的滚动快照，早于首次同步的日期没有数据。",
      attributor.state === "ready"
        ? `品牌归属：已映射系统 SKU 优先，其余按数据中台店铺档案（${attributor.shopsWithBrand}/${attributor.shops} 家店铺有品牌）${dCmp(guessed, "0") > 0 ? `；仍有 ${guessed} 件靠店铺名回退` : ""}${missingShops.length ? `；${missingShops.length} 家观察到的店铺不在档案里` : ""}。`
        : "店铺档案流未同步：未映射平台 SKU 的品牌只能按店铺名回退推断。",
      "品牌 × 平台矩阵各列口径不同，总件数只用于排序，不代表全渠道合计。",
    ],
  };
}

function buildBrandMatrix(
  platforms: ChannelPlatformRow[],
  brandAmountOverride: Partial<Record<ChannelPlatform, Map<string, string> | null>> = {},
): BrandPlatformRow[] {
  const map = new Map<string, BrandPlatformRow>();
  const cell = (p: ChannelPlatformRow): { units: string | null; amount: string | null } => (p.state === "ready" ? { units: "0.0000", amount: null } : { units: null, amount: null });
  const blank = (): BrandPlatformRow["platforms"] => ({ "天猫": cell(platforms[0]), "拼多多": cell(platforms[1]), "唯品会": cell(platforms[2]) });
  const rowOf = (brand: string) => { const row = map.get(brand) ?? { brand, platforms: blank(), totalUnits: "0.0000" }; map.set(brand, row); return row; };
  for (const p of platforms) {
    if (p.state !== "ready") continue;
    for (const b of p.byBrand) {
      const row = rowOf(b.brand);
      const c = row.platforms[p.platform];
      c.units = dAdd(c.units ?? "0.0000", b.units, 4);
      if (b.amount != null) c.amount = dAdd(c.amount ?? "0.00", b.amount, 2);
      row.totalUnits = dAdd(row.totalUnits, b.units, 4);
    }
  }
  for (const [platform, amounts] of Object.entries(brandAmountOverride) as [ChannelPlatform, Map<string, string> | null][]) {
    if (!amounts) continue;
    for (const [brand, amount] of amounts) rowOf(brand).platforms[platform].amount = amount;
  }
  return [...map.values()].sort((a, b) => dCmp(b.totalUnits, a.totalUnits) || a.brand.localeCompare(b.brand, "zh-CN"));
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function binding(db: ReadDb): Promise<string> {
  const [a, b, c, d, pddCw, traffic, cost, shopMaster, brandMaster, pddShopDaily, pddProductDaily] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", { allowQualityBlocked: "snapshot" }), latestBatch(db, "tmall-sku-refund-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "vip-shop-trading-observation", { allowQualityBlocked: "snapshot" }), latestBatch(db, "tmall-product-pnl-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "pdd-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "tmall-product-traffic-observation", { allowQualityBlocked: "snapshot" }), latestBatch(db, "tmall-sku-cost-pnl-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "shop-master-observation", { allowQualityBlocked: true }), latestBatch(db, "brand-master-observation", { allowQualityBlocked: true }),
    latestBatch(db, "pdd-shop-daily-observation", { allowQualityBlocked: "snapshot" }), latestBatch(db, "pdd-product-daily-observation", { allowQualityBlocked: "snapshot" }),
  ]);
  const pdd = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT coalesce(string_agg(
      ir.id::text || ':' || ir.import_job_id::text || ':' || ir.finished_at::text || ':' || coalesce(ir.request_scope::text, '{}'),
      ',' ORDER BY ir.id
    ), 'none') AS retained FROM integration_runs ir
    WHERE ir.connector = 'jdy' AND ir.stream = 'pdd-order-observation' AND ir.status = 'succeeded'
      AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
      AND ir.finished_at > now() - interval '90 days'`))[0];
  const cw = await latestBatch(db, "tmall-sku-crosswalk-observation", { allowQualityBlocked: true });
  const claims = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n,
           coalesce(max(id), 0)::int AS m,
           count(*) FILTER (WHERE active = true)::int AS active_n,
           coalesce(max(updated_at), 'epoch')::text AS updated
    FROM sku_identifiers
    WHERE kind = 'external' AND scope IN ('JIANDAOYUN:TMALL', 'JIANDAOYUN:PDD')
  `))[0];
  return `tmall:${a?.importJobId ?? "none"}:${b?.importJobId ?? "none"}:${cw?.importJobId ?? "none"}:${num(claims?.n)}:${num(claims?.m)}:${num(claims?.active_n)}:${String(claims?.updated ?? "")}|vip:${c?.importJobId ?? "none"}|pnl:${d?.importJobId ?? "none"}|pdd:${String(pdd?.retained ?? "none")}:${pddCw?.importJobId ?? "none"}|traffic:${traffic?.importJobId ?? "none"}|cost:${cost?.importJobId ?? "none"}|shop:${shopMaster?.importJobId ?? "none"}:${brandMaster?.importJobId ?? "none"}|pddDaily:${pddShopDaily?.importJobId ?? "none"}:${pddProductDaily?.importJobId ?? "none"}`;
}

export async function loadChannelObservation(db: ReadDb): Promise<ChannelObservation> {
  const key = await binding(db);
  const cached = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${READ_MODEL_CACHE_KEY} AND source_binding = ${key} LIMIT 1`))[0];
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<ChannelObservation>).authority === "observation_only" && Array.isArray((parsed as Partial<ChannelObservation>).platforms) && Array.isArray((parsed as Partial<ChannelObservation>).brandMatrix)) {
    return parsed as ChannelObservation;
  }
  return refreshChannelObservation(db);
}

export async function refreshChannelObservation(db: ReadDb): Promise<ChannelObservation> {
  const key = await binding(db);
  const result = await computeChannelObservation(db);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${READ_MODEL_CACHE_KEY}, ${key}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return result;
}

/** 供内部口径对比：天猫净件数 − 拼多多件数不可相加时仍各自保留 */
export const channelObservationDiff = (a: string, b: string): string => dSub(a, b, 2);

/* ────────────────────────── D62 店铺 → 渠道映射（只映射，不改任何观察口径） ────────────────────────── */

/** 店铺→渠道别名的固定 scope（aliases.alias_type='channel'，scope='JIANDAOYUN'） */
export const SHOP_CHANNEL_ALIAS_SCOPE = "JIANDAOYUN";

export interface ShopChannelMap {
  /** 店铺名 → channels.id；未映射 = null（保留键，便于页面标「未映射」） */
  byShop: Record<string, number | null>;
  /** 未映射店铺（去重、保序） */
  unmapped: string[];
  mappedCount: number;
}

/**
 * 读取店铺→渠道映射：只读 aliases(aliasType=channel, scope=JIANDAOYUN)，按 raw_value 精确匹配店铺名。
 * 不做模糊/品牌推断——受限用户的裁剪只能建立在人工登记的映射上，未映射店铺一律不归属。
 */
export async function loadShopChannelMap(db: ReadDb, shopNames: readonly string[]): Promise<ShopChannelMap> {
  const shops = [...new Set(shopNames.map((s) => String(s ?? "").trim()).filter(Boolean))];
  const byShop: Record<string, number | null> = {};
  for (const s of shops) byShop[s] = null;
  if (shops.length > 0) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      SELECT raw_value, target_id FROM aliases
      WHERE alias_type = 'channel' AND scope = ${SHOP_CHANNEL_ALIAS_SCOPE}
        AND raw_value IN (${sql.join(shops.map((s) => sql`${s}`), sql`, `)})
    `));
    for (const r of rows) {
      const shop = String(r.raw_value ?? "");
      const id = num(r.target_id);
      if (shop in byShop && id > 0) byShop[shop] = id;
    }
  }
  const unmapped = shops.filter((s) => byShop[s] == null);
  return { byShop, unmapped, mappedCount: shops.length - unmapped.length };
}

/**
 * 未映射店铺进 alias_exceptions 复核队列（幂等：同 type/scope/值只排一次；与 dimension/resolver.queueException 同语义，
 * 这里用 ReadDb.execute 以适配读模型的 db 契约）。返回本次新入队条数。
 * 观察层的复核队列不是业务过账，不写 audit（与既有导入解析路径一致）。
 */
export async function queueUnmappedShops(db: ReadDb, shopNames: readonly string[], context: unknown = { source: "channel-observation" }): Promise<number> {
  const shops = [...new Set(shopNames.map((s) => String(s ?? "").trim()).filter(Boolean))];
  let inserted = 0;
  for (const shop of shops) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      INSERT INTO alias_exceptions (alias_type, scope, raw_value, context, status)
      VALUES ('channel', ${SHOP_CHANNEL_ALIAS_SCOPE}, ${shop}, ${JSON.stringify(context)}::jsonb, 'open')
      ON CONFLICT (alias_type, scope, raw_value) DO NOTHING
      RETURNING id
    `));
    inserted += rows.length;
  }
  return inserted;
}

/**
 * 按渠道范围裁剪「店铺维」行（纯函数）：scope.channelIds 为 null 时原样拷贝；受限时只留映射到范围内渠道的店铺，
 * 未映射店铺一律剔除（不能归属就不能给受限用户看）。
 */
export function filterShopRowsByChannelScope<T>(
  rows: readonly T[],
  getShop: (row: T) => string,
  map: ShopChannelMap,
  scope: { channelIds: number[] | null },
): T[] {
  if (scope.channelIds === null) return [...rows];
  const allowed = new Set(scope.channelIds);
  return rows.filter((r) => {
    const id = map.byShop[getShop(r).trim()];
    return id != null && allowed.has(id);
  });
}
