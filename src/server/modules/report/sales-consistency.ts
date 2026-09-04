/**
 * 销量口径一致性读模型（D65，`sales-consistency/v2`，observation_only）。
 *
 * 内部 sales_monthly（指定渠道，默认 tmall）vs 简道云天猫日销观察（支付件数 − 成功退款件数）
 * 按 SKU × 自然月对比。三阈值（均可调）：
 * - relPct       相对容差：|内部 − 外部| ≤ max(内部, 外部) × relPct%  视为一致；
 * - absFloorQty  绝对容差下限：差异 ≤ absFloorQty 件恒视为一致（小量噪声不算例外）；
 * - minBaseQty   绝对量下限：两侧均 < minBaseQty 的 SKU 月不进分母（below_floor，避免小样本抬高/拉低一致率）。
 * 只比较**两侧都有数据的月份**：内部 sales_monthly 存在该 SKU×月，且外部该月「完整」——
 * 外部完整月 = 观察首日所在月（首日非 1 号则从下一月起）到锚点（最新观察日）所在月之前的自然月；
 * 锚点月与观察首日不足整月的头月一律不比（v1 曾把外部只覆盖半个月的头月拿来比，生产首跑一致率 1.35% 即由此而来）。
 * 输出 comparedMonths（实际比较月）/ skippedMonths（外部完整但 sales_monthly 无任何记录的「内部缺月」）/
 * partialMonths（外部不完整月）；单侧缺失记为未覆盖，绝不补 0，也不记为不一致。
 * 身份映射沿用外部销速的前两条桥（对照表唯一 skuId ∪ 直接认领）；组合装拆解桥不用（口径保守）。
 * 目前只覆盖天猫；拼多多/唯品会没有内部月销量对照口径，不度量。
 */
import { sql, type SQL } from "drizzle-orm";

import { dCmp, dDiv, dMax, dMul, dQty, dSub } from "@/server/core/decimal";
import { getNumParam } from "@/server/core/params";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

export const SALES_CONSISTENCY_CACHE_KEY = "sales-consistency/v2";
const PLATFORM_SKU_IDENTIFIER_SCOPE = "JIANDAOYUN:TMALL";
const EXCEPTION_LIMIT = 200;

export interface SalesConsistencyThresholds {
  relPct: number;
  absFloorQty: number;
  minBaseQty: number;
}

export const DEFAULT_SALES_CONSISTENCY_THRESHOLDS: SalesConsistencyThresholds = { relPct: 10, absFloorQty: 5, minBaseQty: 10 };

export type SalesConsistencyStatus = "consistent" | "exception" | "below_floor";

export interface SalesConsistencyRow {
  skuId: number;
  skuCode: string;
  skuName: string;
  month: string;
  internalQty: string;
  externalQty: string;
  /** 内部 − 外部（scale 4） */
  diffQty: string;
  /** |差异| ÷ max(内部, 外部) × 100（2dp）；两侧皆 0 → null */
  diffPct: number | null;
  status: SalesConsistencyStatus;
}

export interface SalesConsistency {
  state: "ready" | "insufficient";
  authority: "observation_only";
  source: "SCM+JIANDAOYUN";
  channelCode: string;
  channelId: number | null;
  anchorDate: string | null;
  batches: { sales: number | null; refunds: number | null; crosswalk: number | null };
  thresholds: SalesConsistencyThresholds;
  /** 与 comparedMonths 相同（页面筛选沿用） */
  months: string[];
  /** 实际比较的月份（两侧都有数据且外部完整） */
  comparedMonths: string[];
  /** 内部缺月：外部完整、但 sales_monthly 该渠道整月无记录，跳过不比、不记为不一致 */
  skippedMonths: string[];
  /** 外部不完整月（观察首日非 1 号的头月、锚点月），不比 */
  partialMonths: string[];
  /** 外部观察日期范围（最早观察日 ~ 锚点） */
  externalRange: { from: string; through: string } | null;
  comparedRows: number;
  consistentRows: number;
  exceptionRows: number;
  belowFloorRows: number;
  /** 一致率 = consistent ÷ (consistent + exception) × 100；分母 0 → null */
  consistencyPct: number | null;
  /** 未覆盖：完整月内单侧缺失（internalOnly / externalOnly）；internalOutsideRangeRows = 内部记录落在外部不完整/未覆盖月 */
  uncovered: { internalOnlyRows: number; externalOnlyRows: number; internalOutsideRangeRows: number };
  exceptions: SalesConsistencyRow[];
  /**
   * 低于量下限的逐行明细（C10 清单页）。**只在 keepBelowFloor 时填充**，
   * 缓存 payload 不含本字段——计算口径没变，缓存键因此不升版。
   */
  belowFloor?: SalesConsistencyRow[];
  gate: string | null;
  limitations: string[];
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

function qtyValue(value: unknown): string {
  const text = value == null ? "" : String(value).trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? dQty(text) : "0.0000";
}

/** [from, to) 之间的自然月键（YYYY-MM），from ≥ to 时为空 */
export function monthsBetween(from: string, to: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return [];
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  while (out.length < 240) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key >= to) break;
    out.push(key);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const LIMITATIONS = [
  "只比较两侧都有数据的月份：内部 sales_monthly 存在该 SKU×月，且外部该月完整（观察首日非 1 号的头月与锚点月不比）；单侧缺失记为未覆盖，不补 0、不记为不一致。",
  "目前仅覆盖天猫（sales_monthly tmall 渠道 vs 天猫日销观察）；拼多多/唯品会没有内部月销量对照口径，不度量。",
  "外部件数 = 天猫支付件数 − 成功退款件数（同批次身份桥：对照表唯一归属 ∪ 直接认领），组合装拆解不计。",
  "sales_monthly 是内部月粒度事实；一致率只说明两套口径是否吻合，不裁定谁对谁错。",
  "只是观察：不修改 sales_monthly，不进入销速/补货/关账。",
];

async function latestBatch(
  db: ReadDb,
  stream: string,
  allowQualityBlocked: boolean | "snapshot",
): Promise<{ importJobId: number; sourceAsOf: string | null } | null> {
  const qualityFilter = allowQualityBlocked === true
    ? sql`true`
    : allowQualityBlocked === "snapshot"
      ? sql`(coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
             OR (coalesce((ir.request_scope->'controlSummary'->>'invalidNumericValues')::int, 0) = 0
                 AND coalesce((ir.request_scope->'controlSummary'->>'reconciliationMismatchedRows')::int, 0) = 0
                 AND coalesce((ir.request_scope->'controlSummary'->>'deletedRows')::int, 0) = 0))`
      : sql`coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'`;
  const [row] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND ij.status <> 'superseded'
      AND ${qualityFilter}
    ORDER BY ir.started_at DESC, ir.id DESC
    LIMIT 1
  `));
  const importJobId = intValue(row?.import_job_id);
  return importJobId > 0 ? { importJobId, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) } : null;
}

export async function resolveSalesConsistencyThresholds(db?: ReadDb): Promise<SalesConsistencyThresholds> {
  const d = DEFAULT_SALES_CONSISTENCY_THRESHOLDS;
  const [relPct, absFloorQty, minBaseQty] = await Promise.all([
    getNumParam("dq_sales_consistency_rel_pct", d.relPct, db),
    getNumParam("dq_sales_consistency_abs_floor_qty", d.absFloorQty, db),
    getNumParam("dq_sales_consistency_min_base_qty", d.minBaseQty, db),
  ]);
  return { relPct, absFloorQty, minBaseQty };
}

/** 单行裁决（纯函数，供单测直接钉住三阈值语义） */
export function judgeConsistency(
  internalQty: string,
  externalQty: string,
  t: SalesConsistencyThresholds,
): { status: SalesConsistencyStatus; diffQty: string; diffPct: number | null } {
  const diffQty = dSub(internalQty, externalQty, 4);
  const absDiff = diffQty.startsWith("-") ? diffQty.slice(1) : diffQty;
  const absInternal = internalQty.startsWith("-") ? internalQty.slice(1) : internalQty;
  const absExternal = externalQty.startsWith("-") ? externalQty.slice(1) : externalQty;
  const base = dMax(absInternal, absExternal, 4);
  const diffPct = dCmp(base, 0) > 0 ? Number(dMul(dDiv(absDiff, base, 6), 100, 2)) : null;
  if (dCmp(base, Math.max(0, t.minBaseQty)) < 0) return { status: "below_floor", diffQty, diffPct };
  const allowed = dMax(Math.max(0, t.absFloorQty), dMul(base, dDiv(Math.max(0, t.relPct), 100, 6), 4), 4);
  return { status: dCmp(absDiff, allowed) <= 0 ? "consistent" : "exception", diffQty, diffPct };
}

function emptyResult(
  channelCode: string,
  channelId: number | null,
  thresholds: SalesConsistencyThresholds,
  gate: string,
  batches: SalesConsistency["batches"],
): SalesConsistency {
  return {
    state: "insufficient",
    authority: "observation_only",
    source: "SCM+JIANDAOYUN",
    channelCode,
    channelId,
    anchorDate: null,
    batches,
    thresholds,
    months: [],
    comparedMonths: [],
    skippedMonths: [],
    partialMonths: [],
    externalRange: null,
    comparedRows: 0,
    consistentRows: 0,
    exceptionRows: 0,
    belowFloorRows: 0,
    consistencyPct: null,
    uncovered: { internalOnlyRows: 0, externalOnlyRows: 0, internalOutsideRangeRows: 0 },
    exceptions: [],
    belowFloor: [],
    gate,
    limitations: LIMITATIONS,
  };
}

export interface SalesConsistencyOptions {
  channelCode?: string;
  thresholds?: SalesConsistencyThresholds;
  /** 额外带回 below_floor 逐行明细（清单页专用；不进缓存 payload） */
  keepBelowFloor?: boolean;
}

export async function computeSalesConsistency(db: ReadDb, opts: SalesConsistencyOptions = {}): Promise<SalesConsistency> {
  const channelCode = opts.channelCode ?? "tmall";
  const thresholds = opts.thresholds ?? await resolveSalesConsistencyThresholds(db);
  const [sales, refunds, crosswalk] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", "snapshot"),
    latestBatch(db, "tmall-sku-refund-observation", "snapshot"),
    latestBatch(db, "tmall-sku-crosswalk-observation", true),
  ]);
  const batches = { sales: sales?.importJobId ?? null, refunds: refunds?.importJobId ?? null, crosswalk: crosswalk?.importJobId ?? null };
  const [channel] = rows<Record<string, unknown>>(await db.execute(sql`SELECT id FROM channels WHERE code = ${channelCode} LIMIT 1`));
  const channelId = channel ? intValue(channel.id) : null;
  if (!sales) return emptyResult(channelCode, channelId, thresholds, "缺少天猫日销量成功批次，一致性保持关闭。", batches);
  if (channelId == null) return emptyResult(channelCode, channelId, thresholds, `渠道主档没有 ${channelCode}，无法定位内部销量。`, batches);

  const result = rows<Record<string, unknown>>(await db.execute(sql`
    WITH cw AS (
      SELECT payload->'data'->>'shopName' AS shop, payload->'data'->>'platformSkuId' AS psku,
             max((payload->'_identity'->>'skuId')::int) AS sku_id,
             count(DISTINCT payload->'_identity'->>'skuId') AS n
      FROM staging_rows
      WHERE import_job_id = ${crosswalk?.importJobId ?? -1}
        AND target_table = 'jdy_tmall_sku_crosswalk_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND payload->'_identity'->>'skuId' IS NOT NULL
      GROUP BY 1, 2
    ),
    direct AS (
      SELECT split_part(value, '|', 1) AS shop, split_part(value, '|', 2) AS psku, sku_id
      FROM sku_identifiers
      WHERE kind = 'external' AND scope = ${PLATFORM_SKU_IDENTIFIER_SCOPE} AND active = true
    ),
    map AS (
      SELECT coalesce(cw.shop, d.shop) AS shop, coalesce(cw.psku, d.psku) AS psku,
             CASE WHEN cw.n = 1 THEN cw.sku_id WHEN cw.n IS NULL THEN d.sku_id ELSE NULL END AS sku_id
      FROM cw FULL JOIN direct d ON d.shop = cw.shop AND d.psku = cw.psku
    ),
    s AS (
      SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10))
             payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku,
             left(payload->'data'->>'statisticalDate', 10)::date AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'paidNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'paidNumber')::numeric ELSE 0 END AS paid
      FROM staging_rows
      WHERE import_job_id = ${sales.importJobId}
        AND target_table = 'jdy_tmall_sku_sales_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ORDER BY payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
    ),
    r AS (
      SELECT DISTINCT ON (payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10))
             payload->'data'->>'shopName' AS shop, payload->'data'->>'skuId' AS psku,
             left(payload->'data'->>'statisticalDate', 10)::date AS d,
             CASE WHEN trim(coalesce(payload->'data'->>'successRefundSuborderNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                  THEN (payload->'data'->>'successRefundSuborderNumber')::numeric ELSE 0 END AS refund
      FROM staging_rows
      WHERE import_job_id = ${refunds?.importJobId ?? -1}
        AND target_table = 'jdy_tmall_sku_refund_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ORDER BY payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
    ),
    anchor AS (SELECT max(d) AS d FROM s),
    head AS (SELECT min(d) AS d FROM s),
    complete_from AS (
      SELECT to_char(CASE WHEN extract(day FROM d) = 1 THEN d ELSE (date_trunc('month', d) + interval '1 month')::date END, 'YYYY-MM') AS m
      FROM head
    ),
    ext AS (
      SELECT sku_id, month, sum(paid) - sum(refund) AS qty FROM (
        SELECT m.sku_id, to_char(s.d, 'YYYY-MM') AS month, s.paid, 0::numeric AS refund
        FROM s INNER JOIN map m ON m.shop = s.shop AND m.psku = s.psku AND m.sku_id IS NOT NULL
        UNION ALL
        SELECT m.sku_id, to_char(r.d, 'YYYY-MM'), 0::numeric, r.refund
        FROM r INNER JOIN map m ON m.shop = r.shop AND m.psku = r.psku AND m.sku_id IS NOT NULL
      ) u
      WHERE month < to_char((SELECT d FROM anchor), 'YYYY-MM')
        AND month >= (SELECT m FROM complete_from)
      GROUP BY sku_id, month
    ),
    internal AS (
      SELECT sku_id, year_month AS month, sum(qty) AS qty
      FROM sales_monthly WHERE channel_id = ${channelId}
      GROUP BY sku_id, year_month
    )
    SELECT coalesce(i.sku_id, e.sku_id) AS sku_id, coalesce(i.month, e.month) AS month,
           i.qty::text AS internal_qty, e.qty::text AS external_qty,
           k.code AS sku_code, k.name AS sku_name,
           (SELECT to_char(d, 'YYYY-MM-DD') FROM anchor) AS anchor,
           (SELECT to_char(d, 'YYYY-MM-DD') FROM head) AS head,
           (SELECT m FROM complete_from) AS complete_from
    FROM internal i FULL JOIN ext e ON e.sku_id = i.sku_id AND e.month = i.month
    LEFT JOIN skus k ON k.id = coalesce(i.sku_id, e.sku_id)
    ORDER BY 2, 1
  `));

  const anchorDate = result.length > 0 && result[0].anchor != null ? String(result[0].anchor) : (sales.sourceAsOf ?? null);
  const headDate = result.length > 0 && result[0].head != null ? String(result[0].head) : null;
  const completeFrom = result.length > 0 && result[0].complete_from != null ? String(result[0].complete_from) : null;
  const anchorMonth = anchorDate ? anchorDate.slice(0, 7) : null;
  const completeMonths = completeFrom && anchorMonth ? monthsBetween(completeFrom, anchorMonth) : [];
  const completeSet = new Set(completeMonths);
  const partialMonths = [...new Set([
    ...(headDate && completeFrom && headDate.slice(0, 7) !== completeFrom ? [headDate.slice(0, 7)] : []),
    ...(anchorMonth ? [anchorMonth] : []),
  ])].sort();
  const months = new Set<string>();
  const internalMonths = new Set<string>();
  const compared: SalesConsistencyRow[] = [];
  let internalOnlyRows = 0;
  let externalOnlyRows = 0;
  let internalOutsideRangeRows = 0;
  for (const row of result) {
    const month = String(row.month ?? "");
    if (row.internal_qty == null && row.external_qty == null) continue;
    if (row.internal_qty != null) internalMonths.add(month);
    if (!completeSet.has(month)) {
      // 外部不完整月 / 外部未覆盖月：只可能出现内部记录（外部行已在 SQL 中按完整月过滤）
      if (row.internal_qty != null) internalOutsideRangeRows += 1;
      continue;
    }
    if (row.internal_qty == null) { externalOnlyRows += 1; continue; }
    if (row.external_qty == null) { internalOnlyRows += 1; continue; }
    const internalQty = qtyValue(row.internal_qty);
    const externalQty = qtyValue(row.external_qty);
    const judged = judgeConsistency(internalQty, externalQty, thresholds);
    months.add(month);
    compared.push({
      skuId: intValue(row.sku_id),
      skuCode: row.sku_code == null ? "" : String(row.sku_code),
      skuName: row.sku_name == null ? "" : String(row.sku_name),
      month,
      internalQty,
      externalQty,
      diffQty: judged.diffQty,
      diffPct: judged.diffPct,
      status: judged.status,
    });
  }
  const consistentRows = compared.filter((r) => r.status === "consistent").length;
  const exceptionRows = compared.filter((r) => r.status === "exception").length;
  const belowFloorRows = compared.filter((r) => r.status === "below_floor").length;
  const denominator = consistentRows + exceptionRows;
  const consistencyPct = denominator > 0 ? Number(dMul(dDiv(consistentRows, denominator, 6), 100, 2)) : null;
  const exceptions = compared
    .filter((r) => r.status === "exception")
    .sort((a, b) => {
      const aa = a.diffQty.startsWith("-") ? a.diffQty.slice(1) : a.diffQty;
      const bb = b.diffQty.startsWith("-") ? b.diffQty.slice(1) : b.diffQty;
      return dCmp(bb, aa) || a.month.localeCompare(b.month) || a.skuId - b.skuId;
    })
    .slice(0, EXCEPTION_LIMIT);
  const comparedMonths = [...months].sort();
  const skippedMonths = completeMonths.filter((m) => !internalMonths.has(m));
  const externalRange = headDate && anchorDate ? { from: headDate, through: anchorDate } : null;
  const gate = compared.length > 0
    ? null
    : completeMonths.length === 0
      ? "外部观察尚不足一个完整自然月，无法比较。"
      : "内部销量与外部观察没有同一 SKU × 完整月的交集，无法比较。";
  return {
    state: compared.length > 0 ? "ready" : "insufficient",
    authority: "observation_only",
    source: "SCM+JIANDAOYUN",
    channelCode,
    channelId,
    anchorDate,
    batches,
    thresholds,
    months: comparedMonths,
    comparedMonths,
    skippedMonths,
    partialMonths,
    externalRange,
    comparedRows: compared.length,
    consistentRows,
    exceptionRows,
    belowFloorRows,
    consistencyPct,
    uncovered: { internalOnlyRows, externalOnlyRows, internalOutsideRangeRows },
    exceptions,
    ...(opts.keepBelowFloor
      ? { belowFloor: compared.filter((r) => r.status === "below_floor").sort((a, b) => a.month.localeCompare(b.month) || a.skuCode.localeCompare(b.skuCode)) }
      : {}),
    gate,
    limitations: [
      ...LIMITATIONS,
      `本次比较月：${comparedMonths.length > 0 ? comparedMonths.join("、") : "无"}；内部缺月（外部完整但 sales_monthly 无记录，跳过不比）：${skippedMonths.length > 0 ? skippedMonths.join("、") : "无"}；外部不完整月（不比）：${partialMonths.length > 0 ? partialMonths.join("、") : "无"}。`,
    ],
  };
}

async function binding(db: ReadDb, channelCode: string, thresholds: SalesConsistencyThresholds): Promise<string> {
  const [sales, refunds, crosswalk] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation", "snapshot"),
    latestBatch(db, "tmall-sku-refund-observation", "snapshot"),
    latestBatch(db, "tmall-sku-crosswalk-observation", true),
  ]);
  const [internal] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n, coalesce(max(id), 0)::int AS m FROM sales_monthly`));
  const [direct] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n, coalesce(max(id), 0)::int AS m, coalesce(max(updated_at), 'epoch')::text AS u
    FROM sku_identifiers WHERE kind = 'external' AND scope = ${PLATFORM_SKU_IDENTIFIER_SCOPE}`));
  return [
    `ch:${channelCode}`,
    `sales:${sales?.importJobId ?? "none"}`,
    `refunds:${refunds?.importJobId ?? "none"}`,
    `cw:${crosswalk?.importJobId ?? "none"}`,
    `internal:${intValue(internal?.n)}:${intValue(internal?.m)}`,
    `direct:${intValue(direct?.n)}:${intValue(direct?.m)}:${String(direct?.u ?? "")}`,
    `t:${thresholds.relPct}/${thresholds.absFloorQty}/${thresholds.minBaseQty}`,
  ].join("|");
}

export async function loadSalesConsistency(db: ReadDb, opts: SalesConsistencyOptions = {}): Promise<SalesConsistency> {
  const channelCode = opts.channelCode ?? "tmall";
  const thresholds = opts.thresholds ?? await resolveSalesConsistencyThresholds(db);
  const key = await binding(db, channelCode, thresholds);
  const [cached] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${SALES_CONSISTENCY_CACHE_KEY} AND source_binding = ${key} LIMIT 1`));
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<SalesConsistency>).authority === "observation_only"
    && Array.isArray((parsed as Partial<SalesConsistency>).exceptions)) {
    return parsed as SalesConsistency;
  }
  return refreshSalesConsistency(db, { channelCode, thresholds });
}

export async function refreshSalesConsistency(db: ReadDb, opts: SalesConsistencyOptions = {}): Promise<SalesConsistency> {
  const channelCode = opts.channelCode ?? "tmall";
  const thresholds = opts.thresholds ?? await resolveSalesConsistencyThresholds(db);
  const key = await binding(db, channelCode, thresholds);
  const result = await computeSalesConsistency(db, { channelCode, thresholds });
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${SALES_CONSISTENCY_CACHE_KEY}, ${key}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return result;
}
