/**
 * 天猫渠道金额贡献观察桥。
 *
 * 只消费简道云三条最新成功、不可变的 staging 批次：支付金额、成功退款金额、
 * 平台费用支付金额。输出停留在店铺×完整自然月，不写财务事实、不分摊到 SKU，
 * 也不把缺少来源的店铺月份补成 0。
 */
import { sql, type SQL } from "drizzle-orm";

import { dAdd, dCmp, dDiv, dMoney, dMul, dSub } from "@/server/core/decimal";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const STREAMS = {
  sales: { stream: "tmall-sku-sales-observation", table: "jdy_tmall_sku_sales_observation" },
  refunds: { stream: "tmall-sku-refund-observation", table: "jdy_tmall_sku_refund_observation" },
  fees: { stream: "platform-fee-observation", table: "jdy_tmall_platform_fee_observation" },
} as const;

type StreamKey = keyof typeof STREAMS;

export interface TmallContributionSourceEvidence {
  stream: string;
  sourceAsOf: string | null;
  businessDateFrom: string | null;
  businessDateThrough: string | null;
  sourceRows: number;
  stagedRows: number;
  validRows: number;
  invalidRows: number;
}

export interface TmallContributionShopMonth {
  month: string;
  shopName: string;
  currency: string;
  comparable: boolean;
  salesRows: number;
  refundRows: number;
  feeRows: number;
  grossPaidAmount: string | null;
  successfulRefundAmount: string | null;
  netCollectedObservation: string | null;
  platformFeePaidAmount: string | null;
  contributionBeforeProductCost: string | null;
  refundAmountRatePct: string | null;
  platformFeeRatePct: string | null;
  missingSources: StreamKey[];
}

export interface TmallContributionMonthSummary {
  month: string;
  currency: string;
  comparableShops: number;
  totalShops: number;
  grossPaidAmount: string;
  successfulRefundAmount: string;
  netCollectedObservation: string;
  platformFeePaidAmount: string;
  contributionBeforeProductCost: string;
  refundAmountRatePct: string | null;
  platformFeeRatePct: string | null;
  excludedFeePaidAmount: string;
}

export interface TmallChannelContributionObservation {
  state: "preview" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  platform: "天猫";
  grain: "完整自然月 × 店铺 × 源表原币";
  latestClosedMonth: string | null;
  commonBusinessDateFrom: string | null;
  commonBusinessDateThrough: string | null;
  sources: Record<StreamKey, TmallContributionSourceEvidence | null>;
  coverage: {
    closedShopMonths: number;
    comparableShopMonths: number;
    missingSalesShopMonths: number;
    missingRefundShopMonths: number;
    missingFeeShopMonths: number;
    latestMonthComparableShops: number;
    latestMonthTotalShops: number;
  };
  monthly: TmallContributionMonthSummary[];
  latestShops: TmallContributionShopMonth[];
  gate: string;
  limitations: string[];
}

interface LatestBatch {
  importJobId: number;
  sourceAsOf: string | null;
  sourceRows: number;
  stagedRows: number;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const value = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(value) ? value as T[] : [];
}

function intValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function textValue(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function moneyValue(value: unknown): string | null {
  const normalized = textValue(value);
  return normalized && /^-?\d+(?:\.\d+)?$/.test(normalized) ? dMoney(normalized) : null;
}

function pct(numerator: string, denominator: string): string | null {
  return dCmp(denominator, "0") === 0
    ? null
    : dMul(dDiv(numerator, denominator, 6), "100", 2);
}

function monthBefore(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthAfter(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(date: string): string {
  const [year, month] = date.slice(0, 7).split("-").map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(day).padStart(2, "0")}`;
}

function closedMonthThrough(date: string): string {
  return date === lastDayOfMonth(date) ? date.slice(0, 7) : monthBefore(date.slice(0, 7));
}

function closedMonthFrom(date: string): string {
  return date.endsWith("-01") ? date.slice(0, 7) : monthAfter(date.slice(0, 7));
}

function emptyObservation(
  sources: TmallChannelContributionObservation["sources"],
  gate: string,
): TmallChannelContributionObservation {
  return {
    state: "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫",
    grain: "完整自然月 × 店铺 × 源表原币",
    latestClosedMonth: null,
    commonBusinessDateFrom: null,
    commonBusinessDateThrough: null,
    sources,
    coverage: {
      closedShopMonths: 0,
      comparableShopMonths: 0,
      missingSalesShopMonths: 0,
      missingRefundShopMonths: 0,
      missingFeeShopMonths: 0,
      latestMonthComparableShops: 0,
      latestMonthTotalShops: 0,
    },
    monthly: [],
    latestShops: [],
    gate,
    limitations: [
      "净回款观察=支付金额−成功退款金额；不含折让、拒付、汇兑和最终平台结算调整。",
      "产品成本前渠道贡献=净回款观察−平台费用；不含商品成本，绝不是毛利或会计利润。",
      "只有三条来源在同一店铺×月份均有记录时才计算；缺失保持未知，不补零。",
      "当前仅覆盖天猫；平台费用没有 SKU 直接归属时禁止按销量自动分摊。",
    ],
  };
}

async function latestBatches(db: ReadDb): Promise<Record<StreamKey, LatestBatch | null>> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (ir.stream) ir.stream, ir.import_job_id, ij.source_as_of,
      ir.source_rows, ir.staged_rows
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy'
      AND ir.stream IN (${STREAMS.sales.stream}, ${STREAMS.refunds.stream}, ${STREAMS.fees.stream})
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
    ORDER BY ir.stream, ir.id DESC
  `);
  const byStream = new Map(rows<Record<string, unknown>>(result).map((row) => [String(row.stream), row]));
  const build = (key: StreamKey): LatestBatch | null => {
    const row = byStream.get(STREAMS[key].stream);
    const importJobId = intValue(row?.import_job_id);
    return importJobId > 0 ? {
      importJobId,
      sourceAsOf: textValue(row?.source_as_of),
      sourceRows: intValue(row?.source_rows),
      stagedRows: intValue(row?.staged_rows),
    } : null;
  };
  return { sales: build("sales"), refunds: build("refunds"), fees: build("fees") };
}

function sourceEvidence(
  key: StreamKey,
  batch: LatestBatch,
  row: Record<string, unknown>,
): TmallContributionSourceEvidence {
  const totalRows = intValue(row.total_rows);
  const validRows = intValue(row.valid_rows);
  return {
    stream: STREAMS[key].stream,
    sourceAsOf: batch.sourceAsOf,
    businessDateFrom: textValue(row.business_date_from),
    businessDateThrough: textValue(row.business_date_through),
    sourceRows: batch.sourceRows,
    stagedRows: batch.stagedRows,
    validRows,
    invalidRows: Math.max(0, totalRows - validRows),
  };
}

/**
 * 构建完整自然月的店铺级金额桥。跨来源控制数不一致或缺来源时只返回受限观察，
 * 不允许下游把缺口解释成 0 费用、0 退款或 0 销售。
 */
export async function loadTmallChannelContributionObservation(
  db: ReadDb,
): Promise<TmallChannelContributionObservation> {
  const batches = await latestBatches(db);
  const initialSources = { sales: null, refunds: null, fees: null } satisfies TmallChannelContributionObservation["sources"];
  if (!batches.sales || !batches.refunds || !batches.fees) {
    const missing = (Object.keys(batches) as StreamKey[]).filter((key) => !batches[key]);
    return emptyObservation(initialSources, `缺少最新成功来源批次：${missing.join("、")}；金额桥不得计算。`);
  }

  const salesJobId = batches.sales.importJobId;
  const refundJobId = batches.refunds.importJobId;
  const feeJobId = batches.fees.importJobId;
  const [controlResult, aggregateResult] = await Promise.all([
    db.execute(sql`
      WITH source_rows AS (
        SELECT 'sales'::text AS source_key,
          left(payload->'data'->>'statisticalDate', 10) AS biz_date,
          payload->'data'->>'paidAmount' AS amount,
          payload->'data'->>'shopName' AS shop_name,
          NULL::text AS currency
        FROM staging_rows WHERE import_job_id = ${salesJobId}
          AND target_table = ${STREAMS.sales.table} AND status IN ('pending', 'validated', 'committed')
        UNION ALL
        SELECT 'refunds', left(payload->'data'->>'statisticalDate', 10),
          payload->'data'->>'successRefundAmount', payload->'data'->>'shopName', NULL::text
        FROM staging_rows WHERE import_job_id = ${refundJobId}
          AND target_table = ${STREAMS.refunds.table} AND status IN ('pending', 'validated', 'committed')
        UNION ALL
        SELECT 'fees', left(payload->'data'->>'statisticalDate', 10),
          payload->'data'->>'paidAmount', payload->'data'->>'shopName',
          payload->'data'->>'paidCurrency'
        FROM staging_rows WHERE import_job_id = ${feeJobId}
          AND target_table = ${STREAMS.fees.table} AND status IN ('pending', 'validated', 'committed')
      ), classified AS (
        SELECT *, biz_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND trim(coalesce(amount, '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          AND nullif(trim(shop_name), '') IS NOT NULL
          AND (source_key <> 'fees' OR nullif(trim(currency), '') IS NOT NULL) AS valid
        FROM source_rows
      )
      SELECT source_key, count(*)::int AS total_rows,
        count(*) FILTER (WHERE valid)::int AS valid_rows,
        min(biz_date) FILTER (WHERE valid) AS business_date_from,
        max(biz_date) FILTER (WHERE valid) AS business_date_through
      FROM classified GROUP BY source_key
    `),
    db.execute(sql`
      WITH sales AS (
        SELECT left(payload->'data'->>'statisticalDate', 7) AS month,
          nullif(trim(payload->'data'->>'shopName'), '') AS shop_name,
          count(*)::int AS rows,
          round(sum(trim(payload->'data'->>'paidAmount')::numeric), 2)::text AS amount
        FROM staging_rows
        WHERE import_job_id = ${salesJobId} AND target_table = ${STREAMS.sales.table}
          AND status IN ('pending', 'validated', 'committed')
          AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND trim(coalesce(payload->'data'->>'paidAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          AND nullif(trim(payload->'data'->>'shopName'), '') IS NOT NULL
        GROUP BY 1, 2
      ), refunds AS (
        SELECT left(payload->'data'->>'statisticalDate', 7) AS month,
          nullif(trim(payload->'data'->>'shopName'), '') AS shop_name,
          count(*)::int AS rows,
          round(sum(trim(payload->'data'->>'successRefundAmount')::numeric), 2)::text AS amount
        FROM staging_rows
        WHERE import_job_id = ${refundJobId} AND target_table = ${STREAMS.refunds.table}
          AND status IN ('pending', 'validated', 'committed')
          AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND trim(coalesce(payload->'data'->>'successRefundAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          AND nullif(trim(payload->'data'->>'shopName'), '') IS NOT NULL
        GROUP BY 1, 2
      ), fees AS (
        SELECT left(payload->'data'->>'statisticalDate', 7) AS month,
          nullif(trim(payload->'data'->>'shopName'), '') AS shop_name,
          count(*)::int AS rows,
          min(nullif(trim(payload->'data'->>'paidCurrency'), '')) AS currency,
          count(DISTINCT nullif(trim(payload->'data'->>'paidCurrency'), ''))::int AS currency_count,
          round(sum(trim(payload->'data'->>'paidAmount')::numeric), 2)::text AS amount
        FROM staging_rows
        WHERE import_job_id = ${feeJobId} AND target_table = ${STREAMS.fees.table}
          AND status IN ('pending', 'validated', 'committed')
          AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND trim(coalesce(payload->'data'->>'paidAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          AND nullif(trim(payload->'data'->>'shopName'), '') IS NOT NULL
        GROUP BY 1, 2
      ), keys AS (
        SELECT month, shop_name FROM sales
        UNION SELECT month, shop_name FROM refunds
        UNION SELECT month, shop_name FROM fees
      )
      SELECT keys.month, keys.shop_name,
        sales.rows AS sales_rows, sales.amount AS gross_paid_amount,
        refunds.rows AS refund_rows, refunds.amount AS refund_amount,
        fees.rows AS fee_rows, fees.amount AS fee_amount, fees.currency, fees.currency_count
      FROM keys
      LEFT JOIN sales USING (month, shop_name)
      LEFT JOIN refunds USING (month, shop_name)
      LEFT JOIN fees USING (month, shop_name)
      ORDER BY keys.month, keys.shop_name
    `),
  ]);

  const controls = new Map(rows<Record<string, unknown>>(controlResult).map((row) => [String(row.source_key), row]));
  const sources: TmallChannelContributionObservation["sources"] = {
    sales: sourceEvidence("sales", batches.sales, controls.get("sales") ?? {}),
    refunds: sourceEvidence("refunds", batches.refunds, controls.get("refunds") ?? {}),
    fees: sourceEvidence("fees", batches.fees, controls.get("fees") ?? {}),
  };
  const sourceList = Object.values(sources);
  if (sourceList.some((source) => !source?.businessDateFrom || !source.businessDateThrough || source.validRows === 0)) {
    return emptyObservation(sources, "至少一条来源没有有效业务日期与金额；金额桥不得计算。");
  }
  const commonBusinessDateFrom = sourceList
    .map((source) => source!.businessDateFrom!)
    .sort()
    .at(-1)!;
  const commonBusinessDateThrough = sourceList
    .map((source) => source!.businessDateThrough!)
    .sort()[0]!;
  if (commonBusinessDateFrom > commonBusinessDateThrough) {
    return emptyObservation(sources, "三条来源没有共同业务日期区间；金额桥不得计算。");
  }
  const latestClosedMonth = closedMonthThrough(commonBusinessDateThrough);
  const firstMonth = closedMonthFrom(commonBusinessDateFrom);

  const shopMonths = rows<Record<string, unknown>>(aggregateResult)
    .map((row): TmallContributionShopMonth => {
      const salesRows = intValue(row.sales_rows);
      const refundRows = intValue(row.refund_rows);
      const feeRows = intValue(row.fee_rows);
      const missingSources: StreamKey[] = [];
      if (salesRows === 0) missingSources.push("sales");
      if (refundRows === 0) missingSources.push("refunds");
      if (feeRows === 0 || intValue(row.currency_count) !== 1) missingSources.push("fees");
      const grossPaidAmount = moneyValue(row.gross_paid_amount);
      const successfulRefundAmount = moneyValue(row.refund_amount);
      const platformFeePaidAmount = moneyValue(row.fee_amount);
      const comparable = missingSources.length === 0
        && grossPaidAmount != null && successfulRefundAmount != null && platformFeePaidAmount != null;
      const netCollectedObservation = comparable
        ? dSub(grossPaidAmount!, successfulRefundAmount!, 2)
        : null;
      const contributionBeforeProductCost = comparable
        ? dSub(netCollectedObservation!, platformFeePaidAmount!, 2)
        : null;
      return {
        month: textValue(row.month) ?? "未提供",
        shopName: textValue(row.shop_name) ?? "未提供",
        currency: textValue(row.currency) ?? "源表未显式标注",
        comparable,
        salesRows,
        refundRows,
        feeRows,
        grossPaidAmount,
        successfulRefundAmount,
        netCollectedObservation,
        platformFeePaidAmount,
        contributionBeforeProductCost,
        refundAmountRatePct: comparable ? pct(successfulRefundAmount!, grossPaidAmount!) : null,
        platformFeeRatePct: comparable ? pct(platformFeePaidAmount!, netCollectedObservation!) : null,
        missingSources,
      };
    })
    .filter((row) => row.month >= firstMonth && row.month <= latestClosedMonth);

  const monthGroups = new Map<string, TmallContributionShopMonth[]>();
  for (const row of shopMonths) {
    const group = monthGroups.get(row.month) ?? [];
    group.push(row);
    monthGroups.set(row.month, group);
  }
  const monthly: TmallContributionMonthSummary[] = [...monthGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, group]) => {
      const comparable = group.filter((row) => row.comparable);
      const sum = (select: (row: TmallContributionShopMonth) => string | null, rowsToUse = comparable) =>
        rowsToUse.reduce((total, row) => dAdd(total, select(row) ?? "0", 2), "0.00");
      const gross = sum((row) => row.grossPaidAmount);
      const refunds = sum((row) => row.successfulRefundAmount);
      const net = sum((row) => row.netCollectedObservation);
      const fees = sum((row) => row.platformFeePaidAmount);
      return {
        month,
        currency: [...new Set(comparable.map((row) => row.currency))].join("/") || "未形成可比",
        comparableShops: comparable.length,
        totalShops: group.length,
        grossPaidAmount: gross,
        successfulRefundAmount: refunds,
        netCollectedObservation: net,
        platformFeePaidAmount: fees,
        contributionBeforeProductCost: sum((row) => row.contributionBeforeProductCost),
        refundAmountRatePct: pct(refunds, gross),
        platformFeeRatePct: pct(fees, net),
        excludedFeePaidAmount: sum((row) => row.platformFeePaidAmount, group.filter((row) => !row.comparable)),
      };
    });
  const latestShops = shopMonths
    .filter((row) => row.month === latestClosedMonth)
    .sort((left, right) => dCmp(right.contributionBeforeProductCost ?? "0", left.contributionBeforeProductCost ?? "0"));
  const coverage = {
    closedShopMonths: shopMonths.length,
    comparableShopMonths: shopMonths.filter((row) => row.comparable).length,
    missingSalesShopMonths: shopMonths.filter((row) => row.missingSources.includes("sales")).length,
    missingRefundShopMonths: shopMonths.filter((row) => row.missingSources.includes("refunds")).length,
    missingFeeShopMonths: shopMonths.filter((row) => row.missingSources.includes("fees")).length,
    latestMonthComparableShops: latestShops.filter((row) => row.comparable).length,
    latestMonthTotalShops: latestShops.length,
  };
  if (!monthly.some((row) => row.comparableShops > 0)) {
    const empty = emptyObservation(sources, "共同完整月份内没有三源均存在的店铺；缺失保持未知，不计算金额桥。");
    return { ...empty, latestClosedMonth, commonBusinessDateFrom, commonBusinessDateThrough, coverage, latestShops };
  }

  return {
    state: "preview",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫",
    grain: "完整自然月 × 店铺 × 源表原币",
    latestClosedMonth,
    commonBusinessDateFrom,
    commonBusinessDateThrough,
    sources,
    coverage,
    monthly,
    latestShops,
    gate: "已形成可重放的三源金额观察桥；仍须财务确认币种、费用归类、折让/拒付和平台控制总量，不得用于关账、凭证、自动定价或供应决策。",
    limitations: emptyObservation(sources, "").limitations,
  };
}
