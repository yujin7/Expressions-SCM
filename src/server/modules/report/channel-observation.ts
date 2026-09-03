/**
 * 全渠道外部观察（近 30 天）：天猫 / 拼多多 / 唯品会 三个平台放到同一张表上。
 *
 * 之前决策工作室只有天猫（日销 SKU 级）。2026-09-02 把另外三条流接进来后，这里把它们
 * 按同一锚点（各自批次内最大业务日）、同一窗口（近 30 天）汇总成一眼能看的"全渠道盘子"：
 *   - 天猫：支付件数 / 支付金额 / 成功退款件数（SKU 日销 + 退款流）
 *   - 拼多多：有效订单件数（剔除已取消/退款成功；订单流 3 天滚动快照按业务键跨批次去重）
 *   - 唯品会：销售额 / 销售量（店铺×品牌日表，品牌级）
 *   - 天猫宝贝损益：真实成交、销售费用、预估毛利/净利，以及净利最高/最低的商品
 *
 * 全部观察口径：不与内部销量事实相加、不进入任何自动决策；缺流保持 insufficient 而不是 0。
 */
import { sql, type SQL } from "drizzle-orm";

import { dAdd, dCmp, dMoney, dSub } from "@/server/core/decimal";
import { pddDemandEligibilitySql } from "@/server/rules/pdd-demand";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const READ_MODEL_CACHE_KEY = "jiandaoyun-channel-observation/v3";
const WINDOW_DAYS = 30;

export interface ChannelPlatformRow {
  platform: "天猫" | "拼多多" | "唯品会";
  state: "ready" | "insufficient";
  grain: string;
  sourceAsOf: string | null;
  anchorDate: string | null;
  windowFrom: string | null;
  /** 近 30 天件数（天猫=支付件数−成功退款子订单；拼多多=有效订单件数；唯品会=销售量） */
  units: number | null;
  /** 近 30 天金额（天猫=支付金额；拼多多=无金额字段 → null；唯品会=销售额） */
  amount: string | null;
  refundUnits: number | null;
  byBrand: { brand: string; units: number; amount: string | null }[];
  byShop: { shop: string; units: number; amount: string | null }[];
  gate: string;
}

export interface ProductPnlRow {
  shopName: string;
  platformProductId: string;
  productName: string | null;
  actualTransactionAmount: string;
  totalSalesCost: string;
  estimatedGrossProfit: string;
  estimatedNetProfit: string;
  paidNumber: number;
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
    ORDER BY ir.id DESC LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  const importJobId = num(row?.import_job_id);
  return importJobId > 0 ? { importJobId, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) } : null;
}

function insufficient(platform: ChannelPlatformRow["platform"], grain: string, gate: string): ChannelPlatformRow {
  return { platform, state: "insufficient", grain, sourceAsOf: null, anchorDate: null, windowFrom: null, units: null, amount: null, refundUnits: null, byBrand: [], byShop: [], gate };
}

/** 店铺名 → 品牌：店铺名里含品牌名（NING / EXPRESSIONS / DEVIANCE / 爱碧生…） */
function brandOfShop(shop: string, brands: { code: string; names: string[] }[]): string {
  const upper = shop.toUpperCase();
  const hits = brands.filter((b) => b.names.some((n) => n.length >= 2 && upper.includes(n.toUpperCase())));
  return hits.length === 1 ? hits[0].code : "(未归属)";
}

export async function computeChannelObservation(db: ReadDb): Promise<ChannelObservation> {
  const [tmallSales, tmallRefunds, crosswalkBatch, pddCrosswalkBatch, vip, pnl, brandRows, trafficBatch, costBatch] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-refund-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "pdd-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "vip-shop-trading-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-product-pnl-observation", { allowQualityBlocked: "snapshot" }),
    db.execute(sql`SELECT code, name_cn, name_en FROM brands`),
    latestBatch(db, "tmall-product-traffic-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "tmall-sku-cost-pnl-observation", { allowQualityBlocked: "snapshot" }),
  ]);
  const brands = resultRows<Record<string, unknown>>(brandRows).map((b) => ({
    code: String(b.code ?? ""), names: [String(b.code ?? ""), text(b.name_cn) ?? "", text(b.name_en) ?? ""].filter(Boolean),
  }));

  /* ── 天猫 ── */
  let tmall = insufficient("天猫", "统计日 × 店铺 × 平台 SKU", "缺少天猫日销量成功批次。");
  if (tmallSales) {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH s AS (
        SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku, left(payload->'data'->>'statisticalDate', 10)::date AS d,
               CASE WHEN trim(coalesce(payload->'data'->>'paidNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'paidNumber')::numeric ELSE 0 END AS paid,
               CASE WHEN trim(coalesce(payload->'data'->>'paidAmount','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'paidAmount')::numeric ELSE 0 END AS amt
        FROM staging_rows WHERE import_job_id = ${tmallSales.importJobId} AND target_table = 'jdy_tmall_sku_sales_observation'
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ),
      r AS (
        SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku, left(payload->'data'->>'statisticalDate', 10)::date AS d,
               CASE WHEN trim(coalesce(payload->'data'->>'successRefundSuborderNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'successRefundSuborderNumber')::numeric ELSE 0 END AS refund
        FROM staging_rows WHERE import_job_id = ${tmallRefunds?.importJobId ?? -1} AND target_table = 'jdy_tmall_sku_refund_observation'
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ),
      a AS (SELECT max(d) AS d FROM s),
      cw AS (
        SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'platformSkuId' AS psku,
               max((payload->'_identity'->>'skuId')::int) AS sku_id, count(DISTINCT payload->'_identity'->>'skuId') AS n
        FROM staging_rows WHERE import_job_id = ${crosswalkBatch?.importJobId ?? -1} AND target_table = 'jdy_tmall_sku_crosswalk_observation'
          AND status IN ('pending','validated','committed') AND payload->'_identity'->>'skuId' IS NOT NULL
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
    const byShop = new Map<string, { units: number; amount: string; refund: number }>();
    const byBrand = new Map<string, { units: number; amount: string }>();
    let units = 0, refund = 0, amount = "0.00";
    for (const x of rows) {
      if (x.kind === "anchor") continue;
      const shop = String(x.shop ?? "");
      const cur = byShop.get(shop) ?? { units: 0, amount: "0.00", refund: 0 };
      cur.units += num(x.paid); cur.amount = dAdd(cur.amount, money(x.amt), 2); cur.refund += num(x.refund);
      byShop.set(shop, cur);
      if (x.kind === "shop") {
        // 已映射的平台 SKU 用系统 SKU 的品牌；未映射的才按店铺名推断（双品牌店不再一律"未归属"）
        const brand = text(x.brand) ?? brandOfShop(shop, brands);
        const b = byBrand.get(brand) ?? { units: 0, amount: "0.00" };
        b.units += num(x.paid); b.amount = dAdd(b.amount, money(x.amt), 2); byBrand.set(brand, b);
        units += num(x.paid); amount = dAdd(amount, money(x.amt), 2);
      } else if (x.kind === "refund") {
        refund += num(x.refund); units -= num(x.refund);
        const brand = text(x.brand) ?? brandOfShop(shop, brands);
        const b = byBrand.get(brand) ?? { units: 0, amount: "0.00" };
        b.units -= num(x.refund); byBrand.set(brand, b);
      }
    }
    tmall = {
      platform: "天猫", state: anchor ? "ready" : "insufficient", grain: "统计日 × 店铺 × 平台 SKU",
      sourceAsOf: tmallSales.sourceAsOf, anchorDate: anchor, windowFrom: anchor ? shiftDate(anchor, -(WINDOW_DAYS - 1)) : null,
      units, amount, refundUnits: refund,
      byBrand: [...byBrand.entries()].map(([brand, v]) => ({ brand, ...v })).sort((a, b) => b.units - a.units),
      byShop: [...byShop.entries()].map(([shop, v]) => ({ shop, units: v.units - v.refund, amount: v.amount })).sort((a, b) => b.units - a.units),
      gate: "支付件数 − 成功退款子订单数；金额为支付金额（未扣退款与费用）。品牌按已映射系统 SKU 归属，未映射按店铺名推断。",
    };
  }

  /* ── 拼多多（订单流：最近 90 天内批次按业务键去重） ── */
  let pdd = insufficient("拼多多", "订单 × 商品 × 商家编码（3 天滚动快照去重累加）", "拼多多订单流尚未同步。");
  {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH b AS (
        SELECT ir.import_job_id FROM integration_runs ir
        WHERE ir.connector = 'jdy' AND ir.stream = 'pdd-order-observation' AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
          AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
          AND ir.finished_at > now() - interval '90 days'
      ),
      o AS (
        SELECT DISTINCT ON (payload->'data'->>'orderNumber', payload->'data'->>'productId', coalesce(payload->'data'->>'merchantSkuCode',''))
               payload->'data'->>'shopName' AS shop,
               payload->'data'->>'productId' AS pid,
               nullif(trim(payload->'data'->>'merchantSkuCode'), '') AS mcode,
               left(payload->'data'->>'statisticalDate', 10)::date AS d,
               CASE WHEN trim(coalesce(payload->'data'->>'productQuantity','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'productQuantity')::numeric ELSE 0 END AS qty,
               coalesce(payload->'data'->>'orderStatus','') AS status,
               coalesce(payload->'data'->>'afterSalesStatus','') AS after_sales_status,
               coalesce(payload->'data'->>'paymentTime','') AS payment_time,
               ij.source_as_of
        FROM staging_rows sr INNER JOIN import_jobs ij ON ij.id = sr.import_job_id
        WHERE sr.import_job_id IN (SELECT import_job_id FROM b) AND sr.target_table = 'jdy_pdd_order_observation'
          AND sr.status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ORDER BY payload->'data'->>'orderNumber', payload->'data'->>'productId', coalesce(payload->'data'->>'merchantSkuCode',''), sr.import_job_id DESC
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
      a AS (SELECT max(d) AS d, max(source_as_of)::text AS as_of FROM attributed)
      SELECT 'anchor' AS kind, a.d::text AS shop, NULL::text AS brand, NULL::numeric AS qty, a.as_of FROM a
      UNION ALL
      SELECT 'shop', attributed.shop, attributed.brand, sum(attributed.qty), NULL
      FROM attributed CROSS JOIN a
      WHERE attributed.d > a.d - ${WINDOW_DAYS}::int
      GROUP BY attributed.shop, attributed.brand
    `));
    const anchorRow = rows.find((x) => x.kind === "anchor");
    const anchor = anchorRow?.shop ? String(anchorRow.shop) : null;
    if (anchor) {
      const byBrand = new Map<string, number>();
      let units = 0;
      const byShop = new Map<string, number>();
      for (const x of rows) {
        if (x.kind !== "shop") continue;
        const shop = String(x.shop ?? ""); const q = num(x.qty);
        units += q; byShop.set(shop, (byShop.get(shop) ?? 0) + q);
        const b = text(x.brand) ?? brandOfShop(shop, brands);
        byBrand.set(b, (byBrand.get(b) ?? 0) + q);
      }
      pdd = {
        platform: "拼多多", state: "ready", grain: "订单 × 商品 × 商家编码（3 天滚动快照去重累加）",
        sourceAsOf: anchorRow?.as_of ? String(anchorRow.as_of).slice(0, 10) : null, anchorDate: anchor, windowFrom: shiftDate(anchor, -(WINDOW_DAYS - 1)),
        units, amount: null, refundUnits: null,
        byBrand: [...byBrand.entries()].map(([brand, u]) => ({ brand, units: u, amount: null })).sort((a, b) => b.units - a.units),
        byShop: [...byShop.entries()].map(([shop, u]) => ({ shop, units: u, amount: null })).sort((a, b) => b.units - a.units),
        gate: "已付款有效订单件数（剔除待付款、已取消/退款成功）；订单流无金额字段。品牌优先按已映射系统 SKU 归属，未映射才按店铺名推断。窗口内批次不足 30 天时件数偏低。",
      };
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
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ),
      a AS (SELECT max(d) AS d FROM v)
      SELECT 'anchor' AS kind, a.d::text AS shop, NULL::text AS brand, NULL::numeric AS qty, NULL::numeric AS amt FROM a
      UNION ALL
      SELECT 'row', v.shop, v.brand, sum(v.qty), sum(v.amt) FROM v CROSS JOIN a WHERE v.d > a.d - ${WINDOW_DAYS}::int GROUP BY v.shop, v.brand
    `));
    const anchor = rows.find((x) => x.kind === "anchor")?.shop ? String(rows.find((x) => x.kind === "anchor")!.shop) : null;
    if (anchor) {
      const byBrand = new Map<string, { units: number; amount: string }>();
      const byShop = new Map<string, { units: number; amount: string }>();
      let units = 0, amount = "0.00";
      for (const x of rows) {
        if (x.kind !== "row") continue;
        const q = num(x.qty); const m = money(x.amt);
        units += q; amount = dAdd(amount, m, 2);
        const brandKey = brandOfShop(String(x.brand ?? ""), brands);
        const b = byBrand.get(brandKey) ?? { units: 0, amount: "0.00" }; b.units += q; b.amount = dAdd(b.amount, m, 2); byBrand.set(brandKey, b);
        const s = byShop.get(String(x.shop ?? "")) ?? { units: 0, amount: "0.00" }; s.units += q; s.amount = dAdd(s.amount, m, 2); byShop.set(String(x.shop ?? ""), s);
      }
      vipRow = {
        platform: "唯品会", state: "ready", grain: "统计日 × 店铺 × 品牌",
        sourceAsOf: vip.sourceAsOf, anchorDate: anchor, windowFrom: shiftDate(anchor, -(WINDOW_DAYS - 1)),
        units, amount, refundUnits: null,
        byBrand: [...byBrand.entries()].map(([brand, v]) => ({ brand, ...v })).sort((a, b) => b.units - a.units),
        byShop: [...byShop.entries()].map(([shop, v]) => ({ shop, ...v })).sort((a, b) => b.units - a.units),
        gate: "平台报表的销售额/销售量（品牌级，不到 SKU）。",
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
      actualTransactionAmount: money(x.amt), totalSalesCost: money(x.cost), estimatedGrossProfit: money(x.gross), estimatedNetProfit: money(x.net), paidNumber: num(x.paid),
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
  return {
    state: platforms.some((p) => p.state === "ready") ? "ready" : "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    windowDays: 30,
    platforms,
    productPnl,
    traffic,
    skuMargin,
    limitations: [
      "三个平台各自按自身批次的最大业务日锚定近 30 天，时点不完全对齐；件数口径也不同（天猫净件数、拼多多有效订单件数、唯品会销售量）。",
      "只是观察：不与内部 sales_monthly 相加、不进入销速/补货/关账。",
      "拼多多订单流只保留最近 90 天内的滚动快照，早于首次同步的日期没有数据。",
    ],
  };
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function binding(db: ReadDb): Promise<string> {
  const [a, b, c, d, pddCw, traffic, cost] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", { allowQualityBlocked: "snapshot" }), latestBatch(db, "tmall-sku-refund-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "vip-shop-trading-observation", { allowQualityBlocked: "snapshot" }), latestBatch(db, "tmall-product-pnl-observation", { allowQualityBlocked: "snapshot" }),
    latestBatch(db, "pdd-sku-crosswalk-observation", { allowQualityBlocked: true }),
    latestBatch(db, "tmall-product-traffic-observation", { allowQualityBlocked: "snapshot" }), latestBatch(db, "tmall-sku-cost-pnl-observation", { allowQualityBlocked: "snapshot" }),
  ]);
  const pdd = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT coalesce(max(ir.import_job_id), 0)::int AS j FROM integration_runs ir
    WHERE ir.connector = 'jdy' AND ir.stream = 'pdd-order-observation' AND ir.status = 'succeeded'
      AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'`))[0];
  const cw = await latestBatch(db, "tmall-sku-crosswalk-observation", { allowQualityBlocked: true });
  const claims = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n,
           coalesce(max(id), 0)::int AS m,
           count(*) FILTER (WHERE active = true)::int AS active_n,
           coalesce(max(updated_at), 'epoch')::text AS updated
    FROM sku_identifiers
    WHERE kind = 'external' AND scope IN ('JIANDAOYUN:TMALL', 'JIANDAOYUN:PDD')
  `))[0];
  return `tmall:${a?.importJobId ?? "none"}:${b?.importJobId ?? "none"}:${cw?.importJobId ?? "none"}:${num(claims?.n)}:${num(claims?.m)}:${num(claims?.active_n)}:${String(claims?.updated ?? "")}|vip:${c?.importJobId ?? "none"}|pnl:${d?.importJobId ?? "none"}|pdd:${num(pdd?.j)}:${pddCw?.importJobId ?? "none"}|traffic:${traffic?.importJobId ?? "none"}|cost:${cost?.importJobId ?? "none"}`;
}

export async function loadChannelObservation(db: ReadDb): Promise<ChannelObservation> {
  const key = await binding(db);
  const cached = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${READ_MODEL_CACHE_KEY} AND source_binding = ${key} LIMIT 1`))[0];
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<ChannelObservation>).authority === "observation_only" && Array.isArray((parsed as Partial<ChannelObservation>).platforms)) {
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
