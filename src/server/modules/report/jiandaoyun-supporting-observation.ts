/**
 * 简道云旧供应链表的历史辅助洞察。
 *
 * 只读取每条流最新成功且不可变的 staging 批次，并只返回聚合指标；不返回供应商、SKU、
 * 仓库或单据原始值。所有结果均为 historical_observation，不能参与共同截止、A1/A2/A3
 * 判断，也不能替代 SCM/聚水潭/用友的当前事实。
 */
import { sql, type SQL } from "drizzle-orm";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

export type JiandaoyunSupportingStream =
  | "purchase-demand-observation"
  | "supplier-observation"
  | "warehouse-observation"
  | "warehouse-transfer-observation"
  | "inventory-count-observation"
  | "sample-management-observation";

export interface SupportingObservationMetric {
  key: string;
  label: string;
  value: string;
  unit: string;
}

export interface JiandaoyunSupportingObservation {
  stream: JiandaoyunSupportingStream;
  authority: "historical_observation";
  runId: number;
  importJobId: number;
  sourceAsOf: string | null;
  businessDateFrom: string | null;
  businessDateThrough: string | null;
  rows: number;
  metrics: SupportingObservationMetric[];
  summary: string;
  gate: string;
}

const STREAM_ORDER: JiandaoyunSupportingStream[] = [
  "purchase-demand-observation",
  "inventory-count-observation",
  "warehouse-observation",
  "warehouse-transfer-observation",
  "supplier-observation",
  "sample-management-observation",
];

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

function intValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function dateValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function metricsValue(value: unknown): SupportingObservationMetric[] {
  const candidate = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return [];
        }
      })()
    : value;
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const key = String(row.key ?? "").trim();
    const label = String(row.label ?? "").trim();
    const metricValue = String(row.value ?? "").trim();
    const unit = String(row.unit ?? "").trim();
    return key && label && metricValue ? [{ key, label, value: metricValue, unit }] : [];
  });
}

function metricSummary(metric: SupportingObservationMetric): string {
  const parsed = Number(metric.value);
  const value = Number.isFinite(parsed)
    ? parsed.toLocaleString("zh-CN", { maximumFractionDigits: 4 })
    : metric.value;
  return `${metric.label} ${value}${metric.unit}`;
}

/**
 * 统一输出六条辅助流的历史流程/完整性摘要。数量用 PostgreSQL numeric 聚合并以字符串输出；
 * 缺失批次保持缺失，不用 0 伪装。
 */
export async function loadJiandaoyunSupportingObservations(
  db: ReadDb,
): Promise<JiandaoyunSupportingObservation[]> {
  const result = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (ir.stream)
        ir.stream, ir.id AS run_id, ir.import_job_id, ij.source_as_of
      FROM integration_runs ir
      INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
      WHERE ir.connector = 'jdy'
        AND ir.stream IN (
          'purchase-demand-observation',
          'supplier-observation',
          'warehouse-observation',
          'warehouse-transfer-observation',
          'inventory-count-observation',
          'sample-management-observation'
        )
        AND ir.status = 'succeeded'
        AND ir.import_job_id IS NOT NULL
      ORDER BY ir.stream, ir.started_at DESC, ir.id DESC
    ), base AS (
      SELECT l.stream, l.run_id, l.import_job_id, l.source_as_of,
        sr.payload->'data' AS data
      FROM latest l
      LEFT JOIN staging_rows sr ON sr.import_job_id = l.import_job_id
        AND sr.status IN ('pending', 'validated', 'committed')
    ), demand AS (
      SELECT *,
        CASE WHEN trim(coalesce(data->>'requestedQty', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(data->>'requestedQty')::numeric ELSE NULL END AS requested_qty,
        CASE WHEN trim(coalesce(data->>'purchasedQty', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(data->>'purchasedQty')::numeric ELSE NULL END AS purchased_qty
      FROM base WHERE stream = 'purchase-demand-observation'
    ), counts AS (
      SELECT *,
        CASE WHEN trim(coalesce(data->>'lossQty', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(data->>'lossQty')::numeric ELSE NULL END AS loss_qty,
        CASE WHEN trim(coalesce(data->>'gainQty', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(data->>'gainQty')::numeric ELSE NULL END AS gain_qty
      FROM base WHERE stream = 'inventory-count-observation'
    ), transfers AS (
      SELECT *,
        CASE WHEN trim(coalesce(data->>'totalQty', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(data->>'totalQty')::numeric ELSE NULL END AS total_qty
      FROM base WHERE stream = 'warehouse-transfer-observation'
    ), warehouses AS (
      SELECT *,
        CASE WHEN trim(coalesce(data->>'capacityM3', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(data->>'capacityM3')::numeric ELSE NULL END AS capacity_m3
      FROM base WHERE stream = 'warehouse-observation'
    ), samples AS (
      SELECT *,
        CASE WHEN trim(coalesce(data->>'totalQty', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN trim(data->>'totalQty')::numeric ELSE NULL END AS total_qty
      FROM base WHERE stream = 'sample-management-observation'
    ), aggregated AS (
      SELECT stream, min(run_id)::int AS run_id, min(import_job_id)::int AS import_job_id,
        min(source_as_of) AS source_as_of,
        min(left(data->>'requestedAt', 10)) FILTER (WHERE left(data->>'requestedAt', 10) ~ '^\\d{4}-\\d{2}-\\d{2}$') AS business_date_from,
        max(left(data->>'requestedAt', 10)) FILTER (WHERE left(data->>'requestedAt', 10) ~ '^\\d{4}-\\d{2}-\\d{2}$') AS business_date_through,
        count(data)::int AS rows,
        jsonb_build_array(
          jsonb_build_object('key','rows','label','需求行','value',count(data)::text,'unit','行'),
          jsonb_build_object('key','requested','label','需求数量','value',round(coalesce(sum(requested_qty),0),4)::text,'unit',''),
          jsonb_build_object('key','purchased','label','已采购数量','value',round(coalesce(sum(purchased_qty),0),4)::text,'unit',''),
          jsonb_build_object('key','open','label','未/部分采购','value',count(*) FILTER (WHERE data->>'purchaseStatus' IN ('未采购','部分采购'))::text,'unit','行')
        ) AS metrics
      FROM demand GROUP BY stream
      UNION ALL
      SELECT stream, min(run_id)::int, min(import_job_id)::int, min(source_as_of),
        min(left(data->>'startedAt', 10)) FILTER (WHERE left(data->>'startedAt', 10) ~ '^\\d{4}-\\d{2}-\\d{2}$'),
        max(left(data->>'finishedAt', 10)) FILTER (WHERE left(data->>'finishedAt', 10) ~ '^\\d{4}-\\d{2}-\\d{2}$'),
        count(data)::int,
        jsonb_build_array(
          jsonb_build_object('key','rows','label','盘点单','value',count(data)::text,'unit','单'),
          jsonb_build_object('key','loss','label','盘亏数量','value',round(coalesce(sum(loss_qty),0),4)::text,'unit',''),
          jsonb_build_object('key','gain','label','盘盈数量','value',round(coalesce(sum(gain_qty),0),4)::text,'unit',''),
          jsonb_build_object('key','adjusted','label','有差异盘点','value',count(*) FILTER (WHERE coalesce(loss_qty,0) <> 0 OR coalesce(gain_qty,0) <> 0)::text,'unit','单')
        )
      FROM counts GROUP BY stream
      UNION ALL
      SELECT stream, min(run_id)::int, min(import_job_id)::int, min(source_as_of), null, null,
        count(data)::int,
        jsonb_build_array(
          jsonb_build_object('key','rows','label','仓库记录','value',count(data)::text,'unit','个'),
          jsonb_build_object('key','enabled','label','启用记录','value',count(*) FILTER (WHERE data->>'status' = '启用')::text,'unit','个'),
          jsonb_build_object('key','capacity','label','登记容量','value',round(coalesce(sum(capacity_m3),0),4)::text,'unit','m³'),
          jsonb_build_object('key','coded','label','有仓库编码','value',count(*) FILTER (WHERE nullif(trim(data->>'warehouseCode'),'') IS NOT NULL)::text,'unit','个')
        )
      FROM warehouses GROUP BY stream
      UNION ALL
      SELECT stream, min(run_id)::int, min(import_job_id)::int, min(source_as_of),
        min(left(data->>'requestedAt', 10)) FILTER (WHERE left(data->>'requestedAt', 10) ~ '^\\d{4}-\\d{2}-\\d{2}$'),
        max(left(coalesce(data->>'inboundAt', data->>'outboundAt'), 10)) FILTER (WHERE left(coalesce(data->>'inboundAt', data->>'outboundAt'), 10) ~ '^\\d{4}-\\d{2}-\\d{2}$'),
        count(data)::int,
        jsonb_build_array(
          jsonb_build_object('key','rows','label','调拨单','value',count(data)::text,'unit','单'),
          jsonb_build_object('key','quantity','label','调拨数量','value',round(coalesce(sum(total_qty),0),4)::text,'unit',''),
          jsonb_build_object('key','outbound','label','已确认出库','value',count(*) FILTER (WHERE data->>'outboundConfirmed' = '确认')::text,'unit','单'),
          jsonb_build_object('key','inbound','label','已确认入库','value',count(*) FILTER (WHERE data->>'inboundConfirmed' = '确认')::text,'unit','单')
        )
      FROM transfers GROUP BY stream
      UNION ALL
      SELECT stream, min(run_id)::int, min(import_job_id)::int, min(source_as_of), null, null,
        count(data)::int,
        jsonb_build_array(
          jsonb_build_object('key','rows','label','供应商记录','value',count(data)::text,'unit','家'),
          jsonb_build_object('key','coded','label','编码完整','value',count(*) FILTER (WHERE nullif(trim(data->>'supplierCode'),'') IS NOT NULL)::text,'unit','家'),
          jsonb_build_object('key','leveled','label','等级完整','value',count(*) FILTER (WHERE nullif(trim(data->>'level'),'') IS NOT NULL)::text,'unit','家'),
          jsonb_build_object('key','terms','label','结算条款完整','value',count(*) FILTER (WHERE nullif(trim(data->>'settlementTerm'),'') IS NOT NULL)::text,'unit','家')
        )
      FROM base WHERE stream = 'supplier-observation' GROUP BY stream
      UNION ALL
      SELECT stream, min(run_id)::int, min(import_job_id)::int, min(source_as_of),
        min(left(data->>'mailedAt', 10)) FILTER (WHERE left(data->>'mailedAt', 10) ~ '^\\d{4}-\\d{2}-\\d{2}$'),
        max(left(coalesce(data->>'approvedAt', data->>'mailedAt'), 10)) FILTER (WHERE left(coalesce(data->>'approvedAt', data->>'mailedAt'), 10) ~ '^\\d{4}-\\d{2}-\\d{2}$'),
        count(data)::int,
        jsonb_build_array(
          jsonb_build_object('key','rows','label','样品批次','value',count(data)::text,'unit','批'),
          jsonb_build_object('key','quantity','label','样品数量','value',round(coalesce(sum(total_qty),0),4)::text,'unit',''),
          jsonb_build_object('key','received','label','已签收','value',count(*) FILTER (WHERE data->>'received' = '已签收')::text,'unit','批'),
          jsonb_build_object('key','nonconforming','label','检验不符合','value',count(*) FILTER (WHERE data->>'inspectionResult' = '不符合')::text,'unit','批')
        )
      FROM samples GROUP BY stream
    )
    SELECT * FROM aggregated
  `);

  const byStream = new Map<JiandaoyunSupportingStream, JiandaoyunSupportingObservation>();
  for (const row of resultRows<Record<string, unknown>>(result)) {
    const stream = String(row.stream) as JiandaoyunSupportingStream;
    if (!STREAM_ORDER.includes(stream)) continue;
    const metrics = metricsValue(row.metrics);
    byStream.set(stream, {
      stream,
      authority: "historical_observation",
      runId: intValue(row.run_id),
      importJobId: intValue(row.import_job_id),
      sourceAsOf: dateValue(row.source_as_of),
      businessDateFrom: dateValue(row.business_date_from),
      businessDateThrough: dateValue(row.business_date_through),
      rows: intValue(row.rows),
      metrics,
      summary: metrics.map(metricSummary).join(" · "),
      gate: "历史辅助观察：只用于流程基线、身份映射与回查；不参与产品放行，不代表当前状态。",
    });
  }
  return STREAM_ORDER.flatMap((stream) => {
    const row = byStream.get(stream);
    return row ? [row] : [];
  });
}
