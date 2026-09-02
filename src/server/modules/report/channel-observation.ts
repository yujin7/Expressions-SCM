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

import { dAdd, dCmp, dMoney, dQty, dSub } from "@/server/core/decimal";
import { pddDemandEligibilitySql } from "@/server/rules/pdd-demand";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const READ_MODEL_CACHE_KEY = "jiandaoyun-channel-observation/v4";
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
  paidNumber: string;
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
  limitations: string[];
}

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

async function latestBatch(db: ReadDb, stream: string): Promise<{ importJobId: number; sourceAsOf: string | null } | null> {
  const result = await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream} AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
      AND coalesce(ir.request_scope->>'emptySource', 'false') = 'false'
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
  const [tmallSales, tmallRefunds, crosswalkBatch, pddCrosswalkBatch, vip, pnl, brandRows] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation"),
    latestBatch(db, "tmall-sku-refund-observation"),
    latestBatch(db, "tmall-sku-crosswalk-observation"),
    latestBatch(db, "pdd-sku-crosswalk-observation"),
    latestBatch(db, "vip-shop-trading-observation"),
    latestBatch(db, "tmall-product-pnl-observation"),
    db.execute(sql`SELECT code, name_cn, name_en FROM brands`),
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
    const byShop = new Map<string, { units: string; amount: string; refund: string }>();
    const byBrand = new Map<string, { units: string; amount: string }>();
    let units = "0.0000", refund = "0.0000", amount = "0.00";
    for (const x of rows) {
      if (x.kind === "anchor") continue;
      const shop = String(x.shop ?? "");
      const cur = byShop.get(shop) ?? { units: "0.0000", amount: "0.00", refund: "0.0000" };
      cur.units = dAdd(cur.units, qty(x.paid), 4); cur.amount = dAdd(cur.amount, money(x.amt), 2); cur.refund = dAdd(cur.refund, qty(x.refund), 4);
      byShop.set(shop, cur);
      if (x.kind === "shop") {
        // 已映射的平台 SKU 用系统 SKU 的品牌；未映射的才按店铺名推断（双品牌店不再一律"未归属"）
        const brand = text(x.brand) ?? brandOfShop(shop, brands);
        const b = byBrand.get(brand) ?? { units: "0.0000", amount: "0.00" };
        b.units = dAdd(b.units, qty(x.paid), 4); b.amount = dAdd(b.amount, money(x.amt), 2); byBrand.set(brand, b);
        units = dAdd(units, qty(x.paid), 4); amount = dAdd(amount, money(x.amt), 2);
      } else if (x.kind === "refund") {
        refund = dAdd(refund, qty(x.refund), 4); units = dSub(units, qty(x.refund), 4);
        const brand = text(x.brand) ?? brandOfShop(shop, brands);
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
      gate: "支付件数 − 成功退款子订单数；金额为支付金额（未扣退款与费用）。品牌按已映射系统 SKU 归属，未映射按店铺名推断。",
    };
  }

  /* ── 拼多多（订单流：最近 90 天内批次按业务键去重） ── */
  let pdd = insufficient("拼多多", "订单 × 商品 × 商家编码（3 天滚动快照去重累加）", "拼多多订单流尚未同步。");
  {
    const rows = resultRows<Record<string, unknown>>(await db.execute(sql`
      WITH b AS (
        SELECT ir.import_job_id,
               least(
                 nullif(ir.request_scope->'window'->>'to', '')::timestamptz,
                 nullif(ir.request_scope->'window'->>'extractionCutoff', '')::timestamptz
               ) AS observed_through_at
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
      for (const x of rows) {
        if (x.kind !== "shop") continue;
        const shop = String(x.shop ?? ""); const q = qty(x.qty);
        units = dAdd(units, q, 4); byShop.set(shop, dAdd(byShop.get(shop) ?? "0.0000", q, 4));
        const b = text(x.brand) ?? brandOfShop(shop, brands);
        byBrand.set(b, dAdd(byBrand.get(b) ?? "0.0000", q, 4));
      }
      pdd = {
        platform: "拼多多", state: "ready", grain: "订单 × 商品 × 商家编码（3 天滚动快照去重累加）",
        sourceAsOf: anchorRow?.as_of ? String(anchorRow.as_of).slice(0, 10) : null, anchorDate: anchor, windowFrom: shiftDate(anchor, -(WINDOW_DAYS - 1)),
        units, amount: null, refundUnits: null,
        byBrand: [...byBrand.entries()].map(([brand, u]) => ({ brand, units: u, amount: null })).sort((a, b) => dCmp(b.units, a.units)),
        byShop: [...byShop.entries()].map(([shop, u]) => ({ shop, units: u, amount: null })).sort((a, b) => dCmp(b.units, a.units)),
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
      const byBrand = new Map<string, { units: string; amount: string }>();
      const byShop = new Map<string, { units: string; amount: string }>();
      let units = "0.0000", amount = "0.00";
      for (const x of rows) {
        if (x.kind !== "row") continue;
        const q = qty(x.qty); const m = money(x.amt);
        units = dAdd(units, q, 4); amount = dAdd(amount, m, 2);
        const brandKey = brandOfShop(String(x.brand ?? ""), brands);
        const b = byBrand.get(brandKey) ?? { units: "0.0000", amount: "0.00" }; b.units = dAdd(b.units, q, 4); b.amount = dAdd(b.amount, m, 2); byBrand.set(brandKey, b);
        const s = byShop.get(String(x.shop ?? "")) ?? { units: "0.0000", amount: "0.00" }; s.units = dAdd(s.units, q, 4); s.amount = dAdd(s.amount, m, 2); byShop.set(String(x.shop ?? ""), s);
      }
      vipRow = {
        platform: "唯品会", state: "ready", grain: "统计日 × 店铺 × 品牌",
        sourceAsOf: vip.sourceAsOf, anchorDate: anchor, windowFrom: shiftDate(anchor, -(WINDOW_DAYS - 1)),
        units, amount, refundUnits: null,
        byBrand: [...byBrand.entries()].map(([brand, v]) => ({ brand, ...v })).sort((a, b) => dCmp(b.units, a.units)),
        byShop: [...byShop.entries()].map(([shop, v]) => ({ shop, ...v })).sort((a, b) => dCmp(b.units, a.units)),
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
        SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'platformProductId' AS pid, max(payload->'data'->>'productName') AS pname,
               left(payload->'data'->>'statisticalDate', 10)::date AS d,
               ${sql.raw(["actualTransactionAmount", "totalSalesCost", "estimatedGrossProfit", "estimatedNetProfit"].map((f) =>
                 `CASE WHEN trim(coalesce(payload->'data'->>'${f}','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'${f}')::numeric ELSE 0 END AS ${f.toLowerCase()}`).join(", "))},
               CASE WHEN trim(coalesce(payload->'data'->>'paidNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->'data'->>'paidNumber')::numeric ELSE 0 END AS paid
        FROM staging_rows WHERE import_job_id = ${pnl.importJobId} AND target_table = 'jdy_tmall_product_pnl_observation'
          AND status IN ('pending','validated','committed') AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        GROUP BY 1, 2, 4, payload->'data'->>'actualTransactionAmount', payload->'data'->>'totalSalesCost', payload->'data'->>'estimatedGrossProfit', payload->'data'->>'estimatedNetProfit', payload->'data'->>'paidNumber'
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

  const platforms = [tmall, pdd, vipRow];
  return {
    state: platforms.some((p) => p.state === "ready") ? "ready" : "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    windowDays: 30,
    platforms,
    productPnl,
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
  const [a, b, c, d, pddCw] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation"), latestBatch(db, "tmall-sku-refund-observation"),
    latestBatch(db, "vip-shop-trading-observation"), latestBatch(db, "tmall-product-pnl-observation"),
    latestBatch(db, "pdd-sku-crosswalk-observation"),
  ]);
  const pdd = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT coalesce(max(ir.import_job_id), 0)::int AS j FROM integration_runs ir
    WHERE ir.connector = 'jdy' AND ir.stream = 'pdd-order-observation' AND ir.status = 'succeeded'
      AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
      AND ir.finished_at > now() - interval '90 days'`))[0];
  const cw = await latestBatch(db, "tmall-sku-crosswalk-observation");
  const claims = resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n,
           coalesce(max(id), 0)::int AS m,
           count(*) FILTER (WHERE active = true)::int AS active_n,
           coalesce(max(updated_at), 'epoch')::text AS updated
    FROM sku_identifiers
    WHERE kind = 'external' AND scope IN ('JIANDAOYUN:TMALL', 'JIANDAOYUN:PDD')
  `))[0];
  return `tmall:${a?.importJobId ?? "none"}:${b?.importJobId ?? "none"}:${cw?.importJobId ?? "none"}:${num(claims?.n)}:${num(claims?.m)}:${num(claims?.active_n)}:${String(claims?.updated ?? "")}|vip:${c?.importJobId ?? "none"}|pnl:${d?.importJobId ?? "none"}|pdd:${num(pdd?.j)}:${pddCw?.importJobId ?? "none"}`;
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
