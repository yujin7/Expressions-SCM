/**
 * 简道云天猫平台费用观察。
 *
 * 只消费最新成功、不可变的 staging 批次，形成财务 UAT 与渠道费用结构证据。
 * 金额始终以 decimal 字符串输出；负数保持冲销语义，不取绝对值。该读模型不写
 * 正式财务事实、不分摊到 SKU，也不代表天猫以外渠道。
 */
import { sql, type SQL } from "drizzle-orm";

import { configuredJiandaoyunContracts } from "@/server/integrations/jiandaoyun-contracts";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const STREAM = "platform-fee-observation";
const TARGET_TABLE = "jdy_tmall_platform_fee_observation";

export interface PlatformFeeAmountSummary {
  currency: string;
  rows: number;
  billingAmount: string;
  paidAmount: string;
  billingPaidDelta: string;
  positivePaidAmount: string;
  reversalPaidAmount: string;
  negativeRows: number;
}

export interface PlatformFeeDimensionRow extends PlatformFeeAmountSummary {
  key: string;
}

export interface JiandaoyunPlatformFeeObservation {
  state: "preview" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  platform: "天猫";
  /** 导入批次记录的源更新时间，不等同于业务统计日期。 */
  sourceAsOf: string | null;
  businessDateFrom: string | null;
  businessDateThrough: string | null;
  selectedForSync: boolean;
  importJobId: number | null;
  runId: number | null;
  gate: string;
  totals: {
    sourceRows: number;
    stagedRows: number;
    validRows: number;
    invalidRows: number;
  };
  quality: {
    invalidDateRows: number;
    invalidBillingAmountRows: number;
    invalidPaidAmountRows: number;
    missingShopRows: number;
    missingFeeItemRows: number;
    missingCurrencyRows: number;
    currencyMismatchRows: number;
  };
  currencies: PlatformFeeAmountSummary[];
  monthly: PlatformFeeDimensionRow[];
  shops: PlatformFeeDimensionRow[];
  feeItems: PlatformFeeDimensionRow[];
  limitations: string[];
}

interface LatestBatch {
  runId: number;
  importJobId: number;
  sourceAsOf: string | null;
  sourceRows: number;
  stagedRows: number;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

function intValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function decimalValue(value: unknown): string {
  const normalized = value == null ? "0.00" : String(value).trim();
  return /^-?\d+(?:\.\d+)?$/.test(normalized) ? normalized : "0.00";
}

function streamSelected(env: NodeJS.ProcessEnv): boolean {
  try {
    return configuredJiandaoyunContracts(env).some((contract) => contract.key === STREAM);
  } catch {
    return false;
  }
}

async function latestBatch(db: ReadDb): Promise<LatestBatch | null> {
  const result = await db.execute(sql`
    SELECT ir.id AS run_id, ir.import_job_id, ij.source_as_of,
      ir.source_rows, ir.staged_rows
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${STREAM}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
    ORDER BY ir.id DESC
    LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  const runId = intValue(row?.run_id);
  const importJobId = intValue(row?.import_job_id);
  if (runId <= 0 || importJobId <= 0) return null;
  return {
    runId,
    importJobId,
    sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of),
    sourceRows: intValue(row?.source_rows),
    stagedRows: intValue(row?.staged_rows),
  };
}

function amountSummary(row: Record<string, unknown>): PlatformFeeAmountSummary {
  return {
    currency: String(row.currency ?? "未提供"),
    rows: intValue(row.rows),
    billingAmount: decimalValue(row.billing_amount),
    paidAmount: decimalValue(row.paid_amount),
    billingPaidDelta: decimalValue(row.billing_paid_delta),
    positivePaidAmount: decimalValue(row.positive_paid_amount),
    reversalPaidAmount: decimalValue(row.reversal_paid_amount),
    negativeRows: intValue(row.negative_rows),
  };
}

function dimensionRows(result: unknown): PlatformFeeDimensionRow[] {
  return resultRows<Record<string, unknown>>(result).map((row) => ({
    key: String(row.dimension_key ?? "未提供"),
    ...amountSummary(row),
  }));
}

function emptyObservation(selectedForSync: boolean, gate: string): JiandaoyunPlatformFeeObservation {
  return {
    state: "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫",
    sourceAsOf: null,
    businessDateFrom: null,
    businessDateThrough: null,
    selectedForSync,
    importJobId: null,
    runId: null,
    gate,
    totals: { sourceRows: 0, stagedRows: 0, validRows: 0, invalidRows: 0 },
    quality: {
      invalidDateRows: 0,
      invalidBillingAmountRows: 0,
      invalidPaidAmountRows: 0,
      missingShopRows: 0,
      missingFeeItemRows: 0,
      missingCurrencyRows: 0,
      currencyMismatchRows: 0,
    },
    currencies: [],
    monthly: [],
    shops: [],
    feeItems: [],
    limitations: [
      "仅覆盖简道云天猫费用项目汇总，不代表其他电商渠道。",
      "没有 SKU 直接归属证据时禁止按销量或名称自动分摊。",
    ],
  };
}

/**
 * 读取最新成功批次并按币种分别汇总。任何币种缺失/不一致行都留在质量计数，
 * 不混进金额控制总量；所有业务金额由 PostgreSQL numeric 完成聚合。
 */
export async function loadJiandaoyunPlatformFeeObservation(
  db: ReadDb,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JiandaoyunPlatformFeeObservation> {
  const selectedForSync = streamSelected(env);
  const batch = await latestBatch(db);
  if (!batch) {
    return emptyObservation(
      selectedForSync,
      "尚无成功的天猫费用观察批次；不得把缺失费用当作零。",
    );
  }

  const baseCte = sql`
    WITH raw AS (
      SELECT
        left(payload->'data'->>'statisticalDate', 10) AS biz_date,
        nullif(trim(payload->'data'->>'shopName'), '') AS shop_name,
        nullif(trim(payload->'data'->>'feeItem'), '') AS fee_item,
        nullif(trim(payload->'data'->>'billingCurrency'), '') AS billing_currency,
        nullif(trim(payload->'data'->>'paidCurrency'), '') AS paid_currency,
        CASE WHEN trim(coalesce(payload->'data'->>'billingAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(payload->'data'->>'billingAmount')::numeric ELSE NULL END AS billing_amount,
        CASE WHEN trim(coalesce(payload->'data'->>'paidAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(payload->'data'->>'paidAmount')::numeric ELSE NULL END AS paid_amount
      FROM staging_rows
      WHERE import_job_id = ${batch.importJobId}
        AND target_table = ${TARGET_TABLE}
        AND status IN ('pending', 'validated', 'committed')
    ), normalized AS (
      SELECT *,
        CASE WHEN billing_currency IS NOT NULL
          AND paid_currency IS NOT NULL
          AND billing_currency = paid_currency
          THEN paid_currency ELSE NULL END AS currency,
        biz_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AS valid_date
      FROM raw
    ), valid AS (
      SELECT * FROM normalized
      WHERE valid_date AND shop_name IS NOT NULL AND fee_item IS NOT NULL
        AND billing_amount IS NOT NULL AND paid_amount IS NOT NULL AND currency IS NOT NULL
    )`;

  const [qualityResult, currencyResult, monthlyResult, shopResult, feeItemResult] = await Promise.all([
    db.execute(sql`${baseCte}
      SELECT count(*)::int AS rows,
        count(*) FILTER (WHERE NOT valid_date)::int AS invalid_date_rows,
        count(*) FILTER (WHERE billing_amount IS NULL)::int AS invalid_billing_amount_rows,
        count(*) FILTER (WHERE paid_amount IS NULL)::int AS invalid_paid_amount_rows,
        count(*) FILTER (WHERE shop_name IS NULL)::int AS missing_shop_rows,
        count(*) FILTER (WHERE fee_item IS NULL)::int AS missing_fee_item_rows,
        count(*) FILTER (WHERE billing_currency IS NULL OR paid_currency IS NULL)::int AS missing_currency_rows,
        count(*) FILTER (WHERE billing_currency IS NOT NULL AND paid_currency IS NOT NULL
          AND billing_currency <> paid_currency)::int AS currency_mismatch_rows,
        (SELECT count(*)::int FROM valid) AS valid_rows,
        (SELECT min(biz_date) FROM valid) AS business_date_from,
        (SELECT max(biz_date) FROM valid) AS business_date_through
      FROM normalized`),
    db.execute(sql`${baseCte}
      SELECT currency, count(*)::int AS rows,
        round(sum(billing_amount), 2)::text AS billing_amount,
        round(sum(paid_amount), 2)::text AS paid_amount,
        round(sum(paid_amount - billing_amount), 2)::text AS billing_paid_delta,
        round(coalesce(sum(paid_amount) FILTER (WHERE paid_amount >= 0), 0), 2)::text AS positive_paid_amount,
        round(coalesce(sum(paid_amount) FILTER (WHERE paid_amount < 0), 0), 2)::text AS reversal_paid_amount,
        count(*) FILTER (WHERE billing_amount < 0 OR paid_amount < 0)::int AS negative_rows
      FROM valid GROUP BY currency ORDER BY currency`),
    db.execute(sql`${baseCte}
      SELECT left(biz_date, 7) AS dimension_key, currency, count(*)::int AS rows,
        round(sum(billing_amount), 2)::text AS billing_amount,
        round(sum(paid_amount), 2)::text AS paid_amount,
        round(sum(paid_amount - billing_amount), 2)::text AS billing_paid_delta,
        round(coalesce(sum(paid_amount) FILTER (WHERE paid_amount >= 0), 0), 2)::text AS positive_paid_amount,
        round(coalesce(sum(paid_amount) FILTER (WHERE paid_amount < 0), 0), 2)::text AS reversal_paid_amount,
        count(*) FILTER (WHERE billing_amount < 0 OR paid_amount < 0)::int AS negative_rows
      FROM valid GROUP BY left(biz_date, 7), currency ORDER BY dimension_key, currency`),
    db.execute(sql`${baseCte}
      SELECT shop_name AS dimension_key, currency, count(*)::int AS rows,
        round(sum(billing_amount), 2)::text AS billing_amount,
        round(sum(paid_amount), 2)::text AS paid_amount,
        round(sum(paid_amount - billing_amount), 2)::text AS billing_paid_delta,
        round(coalesce(sum(paid_amount) FILTER (WHERE paid_amount >= 0), 0), 2)::text AS positive_paid_amount,
        round(coalesce(sum(paid_amount) FILTER (WHERE paid_amount < 0), 0), 2)::text AS reversal_paid_amount,
        count(*) FILTER (WHERE billing_amount < 0 OR paid_amount < 0)::int AS negative_rows
      FROM valid GROUP BY shop_name, currency
      ORDER BY sum(paid_amount) DESC NULLS LAST, shop_name, currency`),
    db.execute(sql`${baseCte}
      SELECT fee_item AS dimension_key, currency, count(*)::int AS rows,
        round(sum(billing_amount), 2)::text AS billing_amount,
        round(sum(paid_amount), 2)::text AS paid_amount,
        round(sum(paid_amount - billing_amount), 2)::text AS billing_paid_delta,
        round(coalesce(sum(paid_amount) FILTER (WHERE paid_amount >= 0), 0), 2)::text AS positive_paid_amount,
        round(coalesce(sum(paid_amount) FILTER (WHERE paid_amount < 0), 0), 2)::text AS reversal_paid_amount,
        count(*) FILTER (WHERE billing_amount < 0 OR paid_amount < 0)::int AS negative_rows
      FROM valid GROUP BY fee_item, currency
      ORDER BY sum(paid_amount) DESC NULLS LAST, fee_item, currency`),
  ]);

  const [qualityRow = {}] = resultRows<Record<string, unknown>>(qualityResult);
  const quality = {
    invalidDateRows: intValue(qualityRow.invalid_date_rows),
    invalidBillingAmountRows: intValue(qualityRow.invalid_billing_amount_rows),
    invalidPaidAmountRows: intValue(qualityRow.invalid_paid_amount_rows),
    missingShopRows: intValue(qualityRow.missing_shop_rows),
    missingFeeItemRows: intValue(qualityRow.missing_fee_item_rows),
    missingCurrencyRows: intValue(qualityRow.missing_currency_rows),
    currencyMismatchRows: intValue(qualityRow.currency_mismatch_rows),
  };
  const observedRows = intValue(qualityRow.rows);
  const validRows = intValue(qualityRow.valid_rows);
  const invalidRows = Math.max(0, observedRows - validRows);
  const businessDateFrom = qualityRow.business_date_from == null
    ? null
    : String(qualityRow.business_date_from);
  const businessDateThrough = qualityRow.business_date_through == null
    ? null
    : String(qualityRow.business_date_through);
  if (validRows === 0) {
    const empty = emptyObservation(
      selectedForSync,
      "最新批次没有通过日期、店铺、费用项、金额与币种校验的记录；费用分析保持关闭。",
    );
    return {
      ...empty,
      sourceAsOf: batch.sourceAsOf,
      businessDateFrom,
      businessDateThrough,
      importJobId: batch.importJobId,
      runId: batch.runId,
      totals: { ...empty.totals, sourceRows: batch.sourceRows, stagedRows: batch.stagedRows, invalidRows },
      quality,
    };
  }

  const qualityIssues = Object.values(quality).reduce((sum, value) => sum + value, 0);
  const gate = !selectedForSync
    ? "只读演练数据可用于财务 UAT；当前部署尚未选中此流，不能作为持续经营或关账依据。"
    : qualityIssues > 0
      ? `发现 ${qualityIssues} 个字段质量问题；仅可核对有效行，禁止进入净毛利或关账。`
      : "观察汇总已生成；仍需财务控制总量、业务 UAT 与产品放行，才能进入净毛利解释。";

  return {
    state: "preview",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫",
    sourceAsOf: batch.sourceAsOf,
    businessDateFrom,
    businessDateThrough,
    selectedForSync,
    importJobId: batch.importJobId,
    runId: batch.runId,
    gate,
    totals: {
      sourceRows: batch.sourceRows,
      stagedRows: batch.stagedRows,
      validRows,
      invalidRows,
    },
    quality,
    currencies: resultRows<Record<string, unknown>>(currencyResult).map(amountSummary),
    monthly: dimensionRows(monthlyResult),
    shops: dimensionRows(shopResult),
    feeItems: dimensionRows(feeItemResult),
    limitations: [
      "仅覆盖简道云天猫费用项目汇总，不代表其他电商渠道。",
      "计费金额与支付金额并列展示；财务确认正式费用字段前不替代账簿。",
      "负数保留为冲销/退回，禁止取绝对值或静默抵消。",
      "源数据没有 SKU 直接归属；禁止按销量、名称或金额比例自动分摊到 SKU。",
    ],
  };
}
