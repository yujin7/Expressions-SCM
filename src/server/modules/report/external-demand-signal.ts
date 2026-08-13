/**
 * 简道云外部需求信号。
 *
 * 这是一个只读、观察口径的数据产品：从每个契约最新一次成功的不可变 staging 批次
 * 计算天猫支付件数、成功退款件数和净需求信号。它绝不写 sales_monthly、库存台账、
 * 销速或补货建议；身份覆盖与数值质量不达标时，限制会随结果一起返回。
 */
import { sql, type SQL } from "drizzle-orm";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const STREAM = {
  crosswalk: "tmall-sku-crosswalk-observation",
  sales: "tmall-sku-sales-observation",
  refunds: "tmall-sku-refund-observation",
} as const;

export interface ExternalDemandSignal {
  state: "ready" | "insufficient";
  authority: "observation_only";
  gate: string | null;
  source: "JIANDAOYUN";
  platform: "天猫";
  sourceAsOf: string | null;
  crosswalkAsOf: string | null;
  daily: {
    date: string;
    paidQty: number;
    refundQty: number;
    netQty: number;
    mappedNetQty: number;
  }[];
  totals: {
    paidQty: number;
    refundQty: number;
    netQty: number;
    mappedPaidQty: number;
    mappedRefundQty: number;
    mappedNetQty: number;
  };
  coverage: {
    salesRows: number;
    mappedSalesRows: number;
    rowPct: number | null;
    platformIdentities: number;
    mappedIdentities: number;
    identityPct: number | null;
    paidQtyPct: number | null;
  };
  quality: {
    invalidSalesRows: number;
    invalidRefundRows: number;
    conflictingCrosswalks: number;
  };
  fulfillment: {
    state: "ready" | "insufficient";
    authority: "comparison_only";
    jstSourceAsOf: string | null;
    grain: "业务日 × SCM SKU（跨店铺、跨仓汇总）";
    gate: string;
    totals: {
      jdyMappedNetQty: number;
      jstMappedOutboundQty: number;
      comparableDemandQty: number;
      comparableOutboundQty: number;
      gapQty: number | null;
      absoluteGapQty: number | null;
    };
    coverage: {
      jdyMappedSkuDays: number;
      jstMappedSkuDays: number;
      comparableSkuDays: number;
      jdyComparablePct: number | null;
      jstComparablePct: number | null;
    };
    daily: {
      date: string;
      mappedNetDemandQty: number;
      jstOutboundQty: number;
      comparableDemandQty: number;
      comparableOutboundQty: number;
      gapQty: number | null;
      onlyJdySkuDays: number;
      onlyJstSkuDays: number;
    }[];
    topGaps: {
      date: string;
      skuId: number;
      skuCode: string | null;
      mappedNetDemandQty: number;
      jstOutboundQty: number;
      gapQty: number;
      absoluteGapQty: number;
    }[];
  };
  topUnmapped: {
    shopName: string;
    platformSkuId: string;
    barcode: string | null;
    exceptionId: number | null;
    exceptionStatus: "open" | "resolved" | "ignored" | null;
    productName: string | null;
    skuName: string | null;
    paidQty: number;
    refundQty: number;
    netQty: number;
  }[];
  limitations: string[];
}

interface LatestBatch {
  importJobId: number;
  sourceAsOf: string | null;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function intValue(value: unknown): number {
  return Math.trunc(numberValue(value));
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

async function latestBatch(
  db: ReadDb,
  connector: "jdy" | "jst",
  stream: string,
): Promise<LatestBatch | null> {
  const result = await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = ${connector} AND ir.stream = ${stream}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
    ORDER BY ir.id DESC
    LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  const importJobId = intValue(row?.import_job_id);
  return importJobId > 0
    ? { importJobId, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) }
    : null;
}

/**
 * SQL 口径说明：
 * - 数字必须先过正则；缺失/非法值不按 0 冒充，而是计入 quality；
 * - 对照键为 (shopName, platformSkuId)，且只有唯一系统 skuId 才算已映射；
 * - 销售与退款分别聚合后再相减，避免明细多对多连接放大数量。
 */
export async function loadJiandaoyunExternalDemandSignal(db: ReadDb): Promise<ExternalDemandSignal> {
  const [crosswalkBatch, salesBatch, refundBatch, jstOutboundBatch] = await Promise.all([
    latestBatch(db, "jdy", STREAM.crosswalk),
    latestBatch(db, "jdy", STREAM.sales),
    latestBatch(db, "jdy", STREAM.refunds),
    latestBatch(db, "jst", "outbound-sales-daily"),
  ]);

  const missing = [
    !crosswalkBatch ? "天猫 SKU 对照" : null,
    !salesBatch ? "天猫日销量" : null,
    !refundBatch ? "天猫退款" : null,
  ].filter(Boolean);
  if (!crosswalkBatch || !salesBatch || !refundBatch) {
    return emptyExternalDemandSignal(`缺少最新成功批次：${missing.join("、")}。外部信号保持关闭。`);
  }

  const baseCtes = sql`
    WITH crosswalk_raw AS (
      SELECT
        coalesce(payload->'data'->>'shopName', '') AS shop_name,
        coalesce(payload->'data'->>'platformSkuId', '') AS platform_sku_id,
        nullif(trim(payload->'data'->>'barcode'), '') AS barcode,
        CASE WHEN coalesce(payload->'_identity'->>'skuId', '') ~ '^[0-9]+$'
          THEN (payload->'_identity'->>'skuId')::int ELSE NULL END AS scm_sku_id
      FROM staging_rows
      WHERE import_job_id = ${crosswalkBatch.importJobId}
        AND target_table = 'jdy_tmall_sku_crosswalk_observation'
        AND status IN ('pending', 'validated', 'committed')
    ), crosswalk AS (
      SELECT shop_name, platform_sku_id,
        CASE WHEN count(DISTINCT barcode) FILTER (WHERE barcode IS NOT NULL) = 1
          THEN max(barcode) ELSE NULL END AS barcode,
        CASE WHEN count(DISTINCT scm_sku_id) FILTER (WHERE scm_sku_id IS NOT NULL) = 1
          THEN max(scm_sku_id) ELSE NULL END AS scm_sku_id,
        count(DISTINCT scm_sku_id) FILTER (WHERE scm_sku_id IS NOT NULL) > 1 AS conflicting
      FROM crosswalk_raw
      WHERE shop_name <> '' AND platform_sku_id <> ''
      GROUP BY shop_name, platform_sku_id
    ), sales_raw AS (
      SELECT
        left(payload->'data'->>'statisticalDate', 10) AS biz_date,
        coalesce(payload->'data'->>'shopName', '') AS shop_name,
        coalesce(payload->'data'->>'skuId', '') AS platform_sku_id,
        nullif(payload->'data'->>'productName', '') AS product_name,
        nullif(payload->'data'->>'skuName', '') AS sku_name,
        CASE WHEN trim(coalesce(payload->'data'->>'paidNumber', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(payload->'data'->>'paidNumber')::numeric ELSE NULL END AS paid_qty
      FROM staging_rows
      WHERE import_job_id = ${salesBatch.importJobId}
        AND target_table = 'jdy_tmall_sku_sales_observation'
        AND status IN ('pending', 'validated', 'committed')
    ), refunds_raw AS (
      SELECT
        left(payload->'data'->>'statisticalDate', 10) AS biz_date,
        coalesce(payload->'data'->>'shopName', '') AS shop_name,
        coalesce(payload->'data'->>'skuId', '') AS platform_sku_id,
        CASE WHEN trim(coalesce(payload->'data'->>'successRefundSuborderNumber', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(payload->'data'->>'successRefundSuborderNumber')::numeric ELSE NULL END AS refund_qty
      FROM staging_rows
      WHERE import_job_id = ${refundBatch.importJobId}
        AND target_table = 'jdy_tmall_sku_refund_observation'
        AND status IN ('pending', 'validated', 'committed')
    ), sales AS (
      SELECT biz_date, shop_name, platform_sku_id,
        max(product_name) AS product_name, max(sku_name) AS sku_name,
        sum(paid_qty) AS paid_qty,
        count(*)::int AS source_rows,
        count(*) FILTER (WHERE paid_qty IS NULL)::int AS invalid_rows
      FROM sales_raw
      GROUP BY biz_date, shop_name, platform_sku_id
    ), refunds AS (
      SELECT biz_date, shop_name, platform_sku_id,
        sum(refund_qty) AS refund_qty,
        count(*) FILTER (WHERE refund_qty IS NULL)::int AS invalid_rows
      FROM refunds_raw
      GROUP BY biz_date, shop_name, platform_sku_id
    ), combined AS (
      SELECT
        s.biz_date, s.shop_name, s.platform_sku_id, s.product_name, s.sku_name,
        s.paid_qty, coalesce(r.refund_qty, 0) AS refund_qty,
        s.source_rows, s.invalid_rows AS invalid_sales_rows,
        coalesce(r.invalid_rows, 0) AS invalid_refund_rows,
        c.barcode, c.scm_sku_id, coalesce(c.conflicting, false) AS conflicting,
        ae.id AS exception_id, ae.status AS exception_status
      FROM sales s
      LEFT JOIN refunds r USING (biz_date, shop_name, platform_sku_id)
      LEFT JOIN crosswalk c USING (shop_name, platform_sku_id)
      LEFT JOIN alias_exceptions ae
        ON ae.alias_type = 'sku_barcode'
        AND ae.scope = 'JIANDAOYUN'
        AND ae.raw_value = c.barcode
    )`;

  const [dailyResult, coverageResult, topUnmappedResult, qualityResult] = await Promise.all([
    db.execute(sql`${baseCtes}
      SELECT biz_date AS date,
        coalesce(sum(paid_qty), 0) AS paid_qty,
        coalesce(sum(refund_qty), 0) AS refund_qty,
        coalesce(sum(paid_qty), 0) - coalesce(sum(refund_qty), 0) AS net_qty,
        coalesce(sum(paid_qty - refund_qty) FILTER (WHERE scm_sku_id IS NOT NULL), 0) AS mapped_net_qty
      FROM combined
      WHERE biz_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY biz_date ORDER BY biz_date`),
    db.execute(sql`${baseCtes}
      SELECT
        count(*)::int AS sales_groups,
        coalesce(sum(source_rows), 0)::int AS sales_rows,
        coalesce(sum(source_rows) FILTER (WHERE scm_sku_id IS NOT NULL), 0)::int AS mapped_sales_rows,
        count(DISTINCT (shop_name, platform_sku_id))::int AS platform_identities,
        count(DISTINCT (shop_name, platform_sku_id)) FILTER (WHERE scm_sku_id IS NOT NULL)::int AS mapped_identities,
        coalesce(sum(paid_qty), 0) AS paid_qty,
        coalesce(sum(refund_qty), 0) AS refund_qty,
        coalesce(sum(paid_qty) FILTER (WHERE scm_sku_id IS NOT NULL), 0) AS mapped_paid_qty,
        coalesce(sum(refund_qty) FILTER (WHERE scm_sku_id IS NOT NULL), 0) AS mapped_refund_qty
      FROM combined`),
    db.execute(sql`${baseCtes}
      SELECT shop_name, platform_sku_id, max(barcode) AS barcode,
        max(exception_id) AS exception_id, max(exception_status) AS exception_status,
        max(product_name) AS product_name,
        max(sku_name) AS sku_name, coalesce(sum(paid_qty), 0) AS paid_qty,
        coalesce(sum(refund_qty), 0) AS refund_qty,
        coalesce(sum(paid_qty), 0) - coalesce(sum(refund_qty), 0) AS net_qty
      FROM combined
      WHERE scm_sku_id IS NULL
      GROUP BY shop_name, platform_sku_id
      ORDER BY paid_qty DESC NULLS LAST, shop_name, platform_sku_id
      LIMIT 30`),
    db.execute(sql`${baseCtes}
      SELECT
        coalesce(sum(invalid_sales_rows), 0)::int AS invalid_sales_rows,
        coalesce(sum(invalid_refund_rows), 0)::int AS invalid_refund_rows,
        (SELECT count(*)::int FROM crosswalk WHERE conflicting) AS conflicting_crosswalks
      FROM combined`),
  ]);

  const dailyRows = resultRows<Record<string, unknown>>(dailyResult);
  const [coverage = {}] = resultRows<Record<string, unknown>>(coverageResult);
  const [quality = {}] = resultRows<Record<string, unknown>>(qualityResult);
  const paidQty = numberValue(coverage.paid_qty);
  const refundQty = numberValue(coverage.refund_qty);
  const mappedPaidQty = numberValue(coverage.mapped_paid_qty);
  const mappedRefundQty = numberValue(coverage.mapped_refund_qty);
  const salesRows = intValue(coverage.sales_rows);
  const mappedSalesRows = intValue(coverage.mapped_sales_rows);
  const platformIdentities = intValue(coverage.platform_identities);
  const mappedIdentities = intValue(coverage.mapped_identities);
  const invalidSalesRows = intValue(quality.invalid_sales_rows);
  const invalidRefundRows = intValue(quality.invalid_refund_rows);
  const conflictingCrosswalks = intValue(quality.conflicting_crosswalks);
  const qualityBlockers = invalidSalesRows + invalidRefundRows + conflictingCrosswalks;
  const fulfillment = jstOutboundBatch
    ? await loadFulfillmentComparison(db, baseCtes, jstOutboundBatch)
    : emptyFulfillmentComparison("尚无聚水潭日出库成功批次，无法建立同窗履约对比。");

  return {
    state: dailyRows.length > 0 ? "ready" : "insufficient",
    authority: "observation_only",
    gate: dailyRows.length === 0
      ? "最新批次没有可用的日期与数量，外部信号保持关闭。"
      : qualityBlockers > 0
        ? `发现 ${qualityBlockers} 个数值或对照质量问题；可查看趋势，但禁止作为正式销售或补货输入。`
        : "观察口径已生成；完成身份覆盖、总量对账、业务 UAT 与放行审批前，禁止进入正式事实和自动决策。",
    source: "JIANDAOYUN",
    platform: "天猫",
    sourceAsOf: salesBatch.sourceAsOf,
    crosswalkAsOf: crosswalkBatch.sourceAsOf,
    daily: dailyRows.map((row) => ({
      date: String(row.date),
      paidQty: numberValue(row.paid_qty),
      refundQty: numberValue(row.refund_qty),
      netQty: numberValue(row.net_qty),
      mappedNetQty: numberValue(row.mapped_net_qty),
    })),
    totals: {
      paidQty,
      refundQty,
      netQty: paidQty - refundQty,
      mappedPaidQty,
      mappedRefundQty,
      mappedNetQty: mappedPaidQty - mappedRefundQty,
    },
    coverage: {
      salesRows,
      mappedSalesRows,
      rowPct: percent(mappedSalesRows, salesRows),
      platformIdentities,
      mappedIdentities,
      identityPct: percent(mappedIdentities, platformIdentities),
      paidQtyPct: percent(mappedPaidQty, paidQty),
    },
    quality: { invalidSalesRows, invalidRefundRows, conflictingCrosswalks },
    fulfillment,
    topUnmapped: resultRows<Record<string, unknown>>(topUnmappedResult).map((row) => ({
      shopName: String(row.shop_name ?? ""),
      platformSkuId: String(row.platform_sku_id ?? ""),
      barcode: row.barcode == null ? null : String(row.barcode),
      exceptionId: row.exception_id == null ? null : intValue(row.exception_id),
      exceptionStatus:
        row.exception_status === "open" || row.exception_status === "resolved" || row.exception_status === "ignored"
          ? row.exception_status
          : null,
      productName: row.product_name == null ? null : String(row.product_name),
      skuName: row.sku_name == null ? null : String(row.sku_name),
      paidQty: numberValue(row.paid_qty),
      refundQty: numberValue(row.refund_qty),
      netQty: numberValue(row.net_qty),
    })),
    limitations: [
      "这是简道云只读观察，不是聚水潭出库事实，也不是用友财务凭证。",
      "净需求信号 = 支付件数 − 成功退款子订单数；不含取消未付款、换货、平台时间差或刷单识别。",
      "未映射平台 SKU 只能计入总体趋势，不能归属系统 SKU、品牌、BOM、库存或补货建议。",
      "只有最新成功批次参与计算；旧批次保留作证据，但不会重复累加。",
    ],
  };
}

export function emptyExternalDemandSignal(gate = "尚未取得完整的简道云外部需求证据。"): ExternalDemandSignal {
  return {
    state: "insufficient",
    authority: "observation_only",
    gate,
    source: "JIANDAOYUN",
    platform: "天猫",
    sourceAsOf: null,
    crosswalkAsOf: null,
    daily: [],
    totals: {
      paidQty: 0, refundQty: 0, netQty: 0,
      mappedPaidQty: 0, mappedRefundQty: 0, mappedNetQty: 0,
    },
    coverage: {
      salesRows: 0, mappedSalesRows: 0, rowPct: null,
      platformIdentities: 0, mappedIdentities: 0, identityPct: null, paidQtyPct: null,
    },
    quality: { invalidSalesRows: 0, invalidRefundRows: 0, conflictingCrosswalks: 0 },
    fulfillment: emptyFulfillmentComparison("简道云需求证据不完整，无法与聚水潭建立可比窗口。"),
    topUnmapped: [],
    limitations: ["缺少完整的销售、退款或 SKU 对照证据，系统不会用 0 填补。"],
  };
}

function emptyFulfillmentComparison(gate: string): ExternalDemandSignal["fulfillment"] {
  return {
    state: "insufficient",
    authority: "comparison_only",
    jstSourceAsOf: null,
    grain: "业务日 × SCM SKU（跨店铺、跨仓汇总）",
    gate,
    totals: {
      jdyMappedNetQty: 0,
      jstMappedOutboundQty: 0,
      comparableDemandQty: 0,
      comparableOutboundQty: 0,
      gapQty: null,
      absoluteGapQty: null,
    },
    coverage: {
      jdyMappedSkuDays: 0,
      jstMappedSkuDays: 0,
      comparableSkuDays: 0,
      jdyComparablePct: null,
      jstComparablePct: null,
    },
    daily: [],
    topGaps: [],
  };
}

async function loadFulfillmentComparison(
  db: ReadDb,
  demandCtes: SQL,
  jstBatch: LatestBatch,
): Promise<ExternalDemandSignal["fulfillment"]> {
  const result = await db.execute(sql`${demandCtes},
    demand_by_sku_day AS (
      SELECT biz_date, scm_sku_id,
        coalesce(sum(paid_qty), 0) - coalesce(sum(refund_qty), 0) AS demand_qty
      FROM combined
      WHERE scm_sku_id IS NOT NULL
        AND biz_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY biz_date, scm_sku_id
    ), jst_raw AS (
      SELECT
        payload->>'bizDate' AS biz_date,
        CASE WHEN coalesce(payload->'_resolved'->>'skuId', '') ~ '^[0-9]+$'
          THEN (payload->'_resolved'->>'skuId')::int ELSE NULL END AS scm_sku_id,
        CASE WHEN trim(coalesce(payload->>'qty', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(payload->>'qty')::numeric ELSE NULL END AS outbound_qty
      FROM staging_rows
      WHERE import_job_id = ${jstBatch.importJobId}
        AND target_table = 'jst_daily_sales'
        AND status IN ('validated', 'committed')
    ), jst_by_sku_day AS (
      SELECT biz_date, scm_sku_id, sum(outbound_qty) AS outbound_qty
      FROM jst_raw
      WHERE scm_sku_id IS NOT NULL AND outbound_qty IS NOT NULL
        AND biz_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY biz_date, scm_sku_id
    ), compared AS (
      SELECT
        coalesce(d.biz_date, j.biz_date) AS biz_date,
        coalesce(d.scm_sku_id, j.scm_sku_id) AS scm_sku_id,
        d.demand_qty,
        j.outbound_qty
      FROM demand_by_sku_day d
      FULL OUTER JOIN jst_by_sku_day j
        ON j.biz_date = d.biz_date AND j.scm_sku_id = d.scm_sku_id
    )
    SELECT c.biz_date, c.scm_sku_id, s.code AS sku_code,
      c.demand_qty, c.outbound_qty
    FROM compared c
    LEFT JOIN skus s ON s.id = c.scm_sku_id
    ORDER BY c.biz_date, c.scm_sku_id`);

  const rows = resultRows<Record<string, unknown>>(result).map((row) => ({
    date: String(row.biz_date ?? ""),
    skuId: intValue(row.scm_sku_id),
    skuCode: row.sku_code == null ? null : String(row.sku_code),
    demandQty: row.demand_qty == null ? null : numberValue(row.demand_qty),
    outboundQty: row.outbound_qty == null ? null : numberValue(row.outbound_qty),
  })).filter((row) => row.date && row.skuId > 0);

  const comparable = rows.filter((row) => row.demandQty !== null && row.outboundQty !== null);
  if (comparable.length === 0) {
    const empty = emptyFulfillmentComparison(
      "简道云与聚水潭最新成功批次没有同业务日、同已映射 SCM SKU 的可比样本；缺失保持未知。",
    );
    empty.jstSourceAsOf = jstBatch.sourceAsOf;
    empty.coverage.jdyMappedSkuDays = rows.filter((row) => row.demandQty !== null).length;
    empty.coverage.jstMappedSkuDays = rows.filter((row) => row.outboundQty !== null).length;
    return empty;
  }

  const jdyRows = rows.filter((row) => row.demandQty !== null);
  const jstRows = rows.filter((row) => row.outboundQty !== null);
  const comparableDemandQty = comparable.reduce((sum, row) => sum + (row.demandQty ?? 0), 0);
  const comparableOutboundQty = comparable.reduce((sum, row) => sum + (row.outboundQty ?? 0), 0);
  const byDate = new Map<string, ExternalDemandSignal["fulfillment"]["daily"][number]>();
  for (const row of rows) {
    const current = byDate.get(row.date) ?? {
      date: row.date,
      mappedNetDemandQty: 0,
      jstOutboundQty: 0,
      comparableDemandQty: 0,
      comparableOutboundQty: 0,
      gapQty: null,
      onlyJdySkuDays: 0,
      onlyJstSkuDays: 0,
    };
    if (row.demandQty !== null) current.mappedNetDemandQty += row.demandQty;
    if (row.outboundQty !== null) current.jstOutboundQty += row.outboundQty;
    if (row.demandQty !== null && row.outboundQty !== null) {
      current.comparableDemandQty += row.demandQty;
      current.comparableOutboundQty += row.outboundQty;
    } else if (row.demandQty !== null) current.onlyJdySkuDays++;
    else current.onlyJstSkuDays++;
    byDate.set(row.date, current);
  }
  const daily = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  for (const row of daily) {
    if (row.comparableDemandQty !== 0 || row.comparableOutboundQty !== 0) {
      row.gapQty = row.comparableOutboundQty - row.comparableDemandQty;
    }
  }
  const topGaps = comparable.map((row) => {
    const gapQty = (row.outboundQty ?? 0) - (row.demandQty ?? 0);
    return {
      date: row.date,
      skuId: row.skuId,
      skuCode: row.skuCode,
      mappedNetDemandQty: row.demandQty ?? 0,
      jstOutboundQty: row.outboundQty ?? 0,
      gapQty,
      absoluteGapQty: Math.abs(gapQty),
    };
  }).sort((left, right) => right.absoluteGapQty - left.absoluteGapQty
    || left.date.localeCompare(right.date)
    || left.skuId - right.skuId).slice(0, 30);
  const gapQty = comparableOutboundQty - comparableDemandQty;

  return {
    state: "ready",
    authority: "comparison_only",
    jstSourceAsOf: jstBatch.sourceAsOf,
    grain: "业务日 × SCM SKU（跨店铺、跨仓汇总）",
    gate: "已建立同业务日、同 SCM SKU 的独立观察对比；店铺/仓身份、控制总量和业务 UAT 完成前禁止解释为漏单或改写正式事实。",
    totals: {
      jdyMappedNetQty: jdyRows.reduce((sum, row) => sum + (row.demandQty ?? 0), 0),
      jstMappedOutboundQty: jstRows.reduce((sum, row) => sum + (row.outboundQty ?? 0), 0),
      comparableDemandQty,
      comparableOutboundQty,
      gapQty,
      absoluteGapQty: Math.abs(gapQty),
    },
    coverage: {
      jdyMappedSkuDays: jdyRows.length,
      jstMappedSkuDays: jstRows.length,
      comparableSkuDays: comparable.length,
      jdyComparablePct: percent(comparable.length, jdyRows.length),
      jstComparablePct: percent(comparable.length, jstRows.length),
    },
    daily,
    topGaps,
  };
}
