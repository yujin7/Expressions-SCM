/**
 * D65 数据质量总览读模型（`data-quality/v2`）：来源类 × 维度（及时性 / 完整性 / 唯一性 / 准确性）。
 *
 * 只算能算的、算不了的留 null 并写明原因（DQ-5）；不做综合分。准确率三条纯规则各自消费：
 * - rules/data-accuracy：recon_diffs SKU 日级一致率（rpa 栏；来源如实为「自有实时仓出库 stock_ledger sales_out
 *   vs 聚水潭日销」，不是快照仓本身）、staging 放行率（manual / external 完整性）；
 * - rules/count-accuracy：已审批盘点单命中率（rpa 并列，仅实时仓）；
 * - rules/snapshot-quality：快照仓相邻批次跳变（rpa 并列，告警数）；
 * - report/sales-consistency：sales_monthly vs 天猫观察 SKU×月一致率（external；只比两侧都有数据的完整月，
 *   内部缺月跳过不记为不一致；目前仅覆盖天猫，拼多多/唯品会不度量）。
 * 本期手工改写指标数（DQ-6）独立列，不进任何准确率分子分母。覆盖起止日按来源类各自取证，缺失不补 0。
 * 缓存：report_read_model_cache key `data-quality/v2`（v2：一致性只比重叠完整月 + 准确率来源文案纠正），
 * source_binding = 各事实表最大 id/计数 + 容差 + 今日。
 */
import { sql, type SQL } from "drizzle-orm";

import {
  IMPORT_TEMPLATE_SOURCE_CLASS, SOURCE_CLASS_DEFS, SOURCE_CLASSES, type SourceClass, templatesOfClass,
} from "@/server/core/data-source-class";
import { getNumParam } from "@/server/core/params";
import { dailyMatchRate, stagingPassRate } from "@/server/rules/data-accuracy";
import { countHitRate } from "@/server/rules/count-accuracy";
import { compareAdjacentSnapshots, type SnapshotFlag } from "@/server/rules/snapshot-quality";
import { isoWeekKey, monthKey, todayShanghai } from "@/server/modules/dq/periods";
import { loadSalesConsistency, type SalesConsistencyThresholds } from "./sales-consistency";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

export const DATA_QUALITY_CACHE_KEY = "data-quality/v2";
export const DQ_RECON_WINDOW_DAYS = 30;
export const DQ_COUNT_WINDOW_DAYS = 90;

export type FreshnessStatus = "current" | "stale" | "unknown";
export type AccuracyStatus = "ok" | "below_target" | "unknown";

export interface DqTimeliness {
  latestAsOf: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  status: FreshnessStatus;
  basis: string;
}

export interface DqRate {
  rate: number | null;
  n: number;
  basis: string;
}

export interface DqAccuracy extends DqRate {
  targetPct: number | null;
  status: AccuracyStatus;
}

export interface DqSourceRow {
  sourceClass: SourceClass;
  label: string;
  templates: string[];
  timeliness: DqTimeliness;
  completeness: DqRate & { ok: number; rejected: number };
  uniqueness: DqRate & { duplicates: number };
  accuracy: DqAccuracy;
  coverage: { from: string | null; through: string | null; basis: string };
}

export interface DqSnapshotWarehouse {
  warehouseId: number;
  code: string;
  name: string;
  prevBizDate: string | null;
  nextBizDate: string;
  prevRows: number;
  nextRows: number;
  qtyDeltaPct: number | null;
  vanished: number;
  vanishedPct: number | null;
  negatives: number;
  flags: SnapshotFlag[];
}

export interface DataQualityReport {
  version: typeof DATA_QUALITY_CACHE_KEY;
  authority: "observation_only";
  today: string;
  tolerancePct: number;
  windows: { reconDays: number; countDays: number };
  sources: DqSourceRow[];
  recon: { matched: number; total: number; rate: number | null; from: string | null; through: string | null };
  count: { docs: number; lines: number; hits: number; rate: number | null };
  snapshotQuality: { warehouses: DqSnapshotWarehouse[]; alerts: number; qtyJumpPct: number; vanishedPct: number };
  salesConsistency: {
    state: "ready" | "insufficient";
    consistencyPct: number | null;
    comparedRows: number;
    exceptionRows: number;
    belowFloorRows: number;
    anchorDate: string | null;
    /** 实际比较月 / 内部缺月（跳过不比）/ 外部不完整月（不比） */
    comparedMonths: string[];
    skippedMonths: string[];
    partialMonths: string[];
    thresholds: SalesConsistencyThresholds;
  };
  manualOverrides: { period: string; count: number; entities: { entity: string; count: number }[] };
  reviews: { pending: number; currentWeek: string; currentMonth: string };
  unregisteredTemplates: string[];
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
function dateValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}
function diffDays(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);
}

function timeliness(latestAsOf: string | null, today: string, maxAgeDays: number, basis: string): DqTimeliness {
  if (!latestAsOf) return { latestAsOf: null, ageDays: null, maxAgeDays, status: "unknown", basis };
  const ageDays = diffDays(latestAsOf, today);
  return { latestAsOf, ageDays, maxAgeDays, status: ageDays > maxAgeDays ? "stale" : "current", basis };
}

function accuracy(rate: number | null, n: number, targetPct: number | null, basis: string): DqAccuracy {
  const status: AccuracyStatus = rate == null ? "unknown" : targetPct != null && rate < targetPct ? "below_target" : "ok";
  return { rate, n, targetPct, status, basis };
}

/** 各来源类模板在近 windowDays 天的导入任务放行率（ok_rows / (ok_rows + fail_rows)） */
async function templatePassRates(db: ReadDb, windowDays: number): Promise<Map<SourceClass, { ok: number; rejected: number }>> {
  const result = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT template, coalesce(sum(ok_rows), 0)::int AS ok, coalesce(sum(fail_rows), 0)::int AS rejected
    FROM import_jobs
    WHERE status IN ('done', 'superseded', 'failed')
      AND created_at > now() - make_interval(days => (${windowDays})::int)
    GROUP BY template
  `));
  const out = new Map<SourceClass, { ok: number; rejected: number }>();
  for (const row of result) {
    const cls = IMPORT_TEMPLATE_SOURCE_CLASS[String(row.template)];
    if (!cls) continue;
    const agg = out.get(cls) ?? { ok: 0, rejected: 0 };
    agg.ok += intValue(row.ok);
    agg.rejected += intValue(row.rejected);
    out.set(cls, agg);
  }
  return out;
}

async function unregisteredTemplates(db: ReadDb): Promise<string[]> {
  const result = rows<Record<string, unknown>>(await db.execute(sql`SELECT DISTINCT template FROM import_jobs ORDER BY template`));
  return result.map((r) => String(r.template)).filter((t) => !IMPORT_TEMPLATE_SOURCE_CLASS[t]);
}

/** 模板集合的 import_jobs 起止（created_at / source_as_of 取证） */
async function templateCoverage(
  db: ReadDb,
  templates: string[],
): Promise<{ from: string | null; through: string | null; latestAsOf: string | null }> {
  if (templates.length === 0) return { from: null, through: null, latestAsOf: null };
  const [row] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT to_char(min(coalesce(source_as_of, created_at::date)), 'YYYY-MM-DD') AS from_d,
           to_char(max(coalesce(source_as_of, created_at::date)), 'YYYY-MM-DD') AS through_d,
           to_char(max(coalesce(source_as_of, created_at::date)) FILTER (WHERE status = 'done'), 'YYYY-MM-DD') AS latest
    FROM import_jobs
    WHERE template IN (${sql.join(templates.map((t) => sql`${t}`), sql`, `)})
  `));
  return { from: dateValue(row?.from_d), through: dateValue(row?.through_d), latestAsOf: dateValue(row?.latest) };
}

async function reconAccuracy(db: ReadDb, tolerancePct: number, windowDays: number): Promise<DataQualityReport["recon"]> {
  const result = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT sys_qty::text AS expected, jst_qty::text AS actual, to_char(biz_date, 'YYYY-MM-DD') AS d
    FROM recon_diffs
    WHERE biz_date > current_date - make_interval(days => (${windowDays})::int)
  `));
  const rate = dailyMatchRate(result.map((r) => ({ expected: String(r.expected), actual: String(r.actual) })), tolerancePct);
  const dates = result.map((r) => String(r.d)).sort();
  return { matched: rate.matched, total: rate.total, rate: rate.rate, from: dates[0] ?? null, through: dates[dates.length - 1] ?? null };
}

async function countAccuracy(db: ReadDb, windowDays: number): Promise<DataQualityReport["count"]> {
  const result = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT l.pd_id, l.book_qty::text AS book_qty, l.counted_qty::text AS counted_qty
    FROM pd_lines l
    INNER JOIN pd_docs d ON d.id = l.pd_id
    INNER JOIN warehouses w ON w.id = d.warehouse_id
    WHERE d.status IN ('approved', 'in_progress', 'completed')
      AND w.accounting_mode = 'realtime'
      AND coalesce(d.biz_date, d.created_at::date) > current_date - make_interval(days => (${windowDays})::int)
  `));
  const hit = countHitRate(result.map((r) => ({ bookQty: String(r.book_qty), countedQty: String(r.counted_qty) })));
  return { docs: new Set(result.map((r) => intValue(r.pd_id))).size, lines: hit.lines, hits: hit.hits, rate: hit.rate };
}

async function snapshotQuality(db: ReadDb, opts: { qtyJumpPct: number; vanishedPct: number }): Promise<DataQualityReport["snapshotQuality"]> {
  const warehousesRows = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT w.id, w.code, w.name,
           (SELECT to_char(max(biz_date), 'YYYY-MM-DD') FROM stock_snapshots s WHERE s.warehouse_id = w.id) AS next_d,
           (SELECT to_char(max(biz_date), 'YYYY-MM-DD') FROM stock_snapshots s WHERE s.warehouse_id = w.id
              AND biz_date < (SELECT max(biz_date) FROM stock_snapshots s2 WHERE s2.warehouse_id = w.id)) AS prev_d
    FROM warehouses w
    WHERE w.accounting_mode = 'snapshot' AND w.active = true
    ORDER BY w.code
  `));
  const out: DqSnapshotWarehouse[] = [];
  for (const w of warehousesRows) {
    const nextBizDate = dateValue(w.next_d);
    if (!nextBizDate) continue;
    const prevBizDate = dateValue(w.prev_d);
    const warehouseId = intValue(w.id);
    const load = async (d: string | null) => d == null ? [] : rows<Record<string, unknown>>(await db.execute(sql`
      SELECT sku_id, qty::text AS qty FROM stock_snapshots WHERE warehouse_id = ${warehouseId} AND biz_date = ${d}::date`))
      .map((r) => ({ skuId: intValue(r.sku_id), qty: String(r.qty) }));
    const [prev, next] = await Promise.all([load(prevBizDate), load(nextBizDate)]);
    const cmp = compareAdjacentSnapshots(prev, next, opts);
    out.push({
      warehouseId, code: String(w.code), name: String(w.name), prevBizDate, nextBizDate,
      prevRows: cmp.prevRows, nextRows: cmp.nextRows, qtyDeltaPct: cmp.qtyDeltaPct,
      vanished: cmp.vanished, vanishedPct: cmp.vanishedPct, negatives: cmp.negatives, flags: cmp.flags,
    });
  }
  const alerts = out.filter((w) => w.flags.some((f) => f === "qty_jump" || f === "vanished" || f === "negatives")).length;
  return { warehouses: out, alerts, qtyJumpPct: opts.qtyJumpPct, vanishedPct: opts.vanishedPct };
}

async function externalUniqueness(db: ReadDb): Promise<{ duplicates: number; total: number; jobId: number | null }> {
  const [batch] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT ir.import_job_id FROM integration_runs ir INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = 'tmall-sku-sales-observation' AND ir.status = 'succeeded'
      AND ir.import_job_id IS NOT NULL AND ij.status <> 'superseded'
    ORDER BY ir.started_at DESC, ir.id DESC LIMIT 1`));
  const jobId = intValue(batch?.import_job_id);
  if (jobId <= 0) return { duplicates: 0, total: 0, jobId: null };
  const [row] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS total,
           (count(*) - count(DISTINCT (payload->'data'->>'shopName') || '|' || (payload->'data'->>'skuId') || '|' || left(payload->'data'->>'statisticalDate', 10)))::int AS dup
    FROM staging_rows WHERE import_job_id = ${jobId} AND target_table = 'jdy_tmall_sku_sales_observation'
      AND status IN ('pending', 'validated', 'committed')`));
  return { duplicates: intValue(row?.dup), total: intValue(row?.total), jobId };
}

async function manualOverrides(db: ReadDb, period: string): Promise<DataQualityReport["manualOverrides"]> {
  const [row] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT count(*)::int AS n FROM sales_amount_monthly
    WHERE supersedes_id IS NOT NULL AND source = 'manual'
      AND to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') = ${period}`));
  const n = intValue(row?.n);
  return { period, count: n, entities: [{ entity: "sales_amount_monthly", count: n }] };
}

function pctRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 100 : null;
}

export async function computeDataQuality(db: ReadDb, opts: { today?: string } = {}): Promise<DataQualityReport> {
  const today = opts.today ?? todayShanghai();
  const [tolerancePct, qtyJumpPct, vanishedPct] = await Promise.all([
    getNumParam("dq_tolerance_pct", 1, db),
    getNumParam("dq_snapshot_qty_jump_pct", 30, db),
    getNumParam("dq_snapshot_vanished_pct", 10, db),
  ]);
  const [passRates, recon, count, snap, uniq, sales, overrides, unregistered, pending, manualDocs, snapshotCoverage] = await Promise.all([
    templatePassRates(db, DQ_RECON_WINDOW_DAYS),
    reconAccuracy(db, tolerancePct, DQ_RECON_WINDOW_DAYS),
    countAccuracy(db, DQ_COUNT_WINDOW_DAYS),
    snapshotQuality(db, { qtyJumpPct, vanishedPct }),
    externalUniqueness(db),
    loadSalesConsistency(db),
    manualOverrides(db, monthKey(today)),
    unregisteredTemplates(db),
    db.execute(sql`SELECT count(*)::int AS n FROM data_quality_reviews WHERE status = 'pending'`),
    db.execute(sql`
      SELECT to_char(min(d), 'YYYY-MM-DD') AS from_d, to_char(max(d), 'YYYY-MM-DD') AS through_d FROM (
        SELECT created_at::date AS d FROM po_docs UNION ALL SELECT created_at::date FROM sh_docs
        UNION ALL SELECT created_at::date FROM bh_docs UNION ALL SELECT created_at::date FROM stock_docs
      ) u`),
    db.execute(sql`SELECT to_char(min(biz_date), 'YYYY-MM-DD') AS from_d, to_char(max(biz_date), 'YYYY-MM-DD') AS through_d FROM stock_snapshots`),
  ]);
  const [manualRow] = rows<Record<string, unknown>>(manualDocs);
  const [snapRow] = rows<Record<string, unknown>>(snapshotCoverage);
  const [pendingRow] = rows<Record<string, unknown>>(pending);

  const coverageByClass = new Map<SourceClass, { from: string | null; through: string | null; latestAsOf: string | null }>();
  for (const cls of SOURCE_CLASSES) coverageByClass.set(cls, await templateCoverage(db, templatesOfClass(cls)));

  const sources: DqSourceRow[] = SOURCE_CLASSES.map((cls) => {
    const def = SOURCE_CLASS_DEFS[cls];
    const pass = passRates.get(cls) ?? { ok: 0, rejected: 0 };
    const passRate = stagingPassRate(pass);
    const jobCoverage = coverageByClass.get(cls)!;
    const completeness = {
      rate: passRate.rate, n: passRate.total, ok: passRate.ok, rejected: passRate.rejected,
      basis: `近 ${DQ_RECON_WINDOW_DAYS} 天该类模板 staging 放行率（成功行 ÷ 总行）`,
    };
    if (cls === "rpa_warehouse") {
      const latest = dateValue(snapRow?.through_d);
      return {
        sourceClass: cls, label: def.label, templates: templatesOfClass(cls),
        timeliness: timeliness(latest, today, def.freshnessMaxAgeDays, "快照仓最新 stock_snapshots.biz_date"),
        completeness,
        uniqueness: { rate: null, n: 0, duplicates: 0, basis: "不度量：同仓同码多行按批次维合法聚合，(仓,SKU,日) 由 UNIQUE 约束保证" },
        accuracy: accuracy(recon.rate, recon.total, def.targetAccuracyPct,
          `近 ${DQ_RECON_WINDOW_DAYS} 天自有实时仓出库（stock_ledger sales_out）vs 聚水潭日销 SKU 日级一致率（recon_diffs，容差 ${tolerancePct}%），不是快照仓本身；并列盘点命中率 ${count.rate ?? "—"}%（${count.lines} 行）与快照跳变告警 ${snap.alerts} 仓`),
        coverage: { from: dateValue(snapRow?.from_d), through: latest, basis: "stock_snapshots.biz_date 起止" },
      };
    }
    if (cls === "manual_po_chain") {
      const through = dateValue(manualRow?.through_d);
      return {
        sourceClass: cls, label: def.label, templates: templatesOfClass(cls),
        timeliness: timeliness(through, today, def.freshnessMaxAgeDays, "BH/PO/SH/库存单据最新创建日"),
        completeness,
        uniqueness: { rate: 100, n: 0, duplicates: 0, basis: "单据 doc_no UNIQUE 约束 + 取号器（doc_counters）保证；导入行不重复计" },
        accuracy: accuracy(passRate.rate, passRate.total, def.targetAccuracyPct,
          `人工模板首次通过率（近 ${DQ_RECON_WINDOW_DAYS} 天 staging 放行率）作为「首次正确率」代理；单据链纠错靠红字冲销留痕`),
        coverage: { from: dateValue(manualRow?.from_d), through, basis: "BH/PO/SH/库存单据创建日起止" },
      };
    }
    if (cls === "external_platform") {
      const latest = jobCoverage.latestAsOf;
      return {
        sourceClass: cls, label: def.label, templates: templatesOfClass(cls),
        timeliness: timeliness(latest, today, def.freshnessMaxAgeDays, "该类连接器批次最新 source_as_of（业务截止日）"),
        completeness: { ...completeness, basis: `近 ${DQ_RECON_WINDOW_DAYS} 天连接器批次 staging 放行率（成功行 ÷ 总行）` },
        uniqueness: {
          rate: uniq.total > 0 ? pctRate(uniq.total - uniq.duplicates, uniq.total) : null, n: uniq.total, duplicates: uniq.duplicates,
          basis: "最新天猫日销批次业务键 (店铺,SKU,统计日) 去重率；读模型按业务键 DISTINCT ON 去重",
        },
        accuracy: accuracy(sales.consistencyPct, sales.comparedRows - sales.belowFloorRows, def.targetAccuracyPct,
          `sales_monthly vs 天猫观察 SKU×完整月一致率（相对 ${sales.thresholds.relPct}% / 绝对 ${sales.thresholds.absFloorQty} 件 / 量下限 ${sales.thresholds.minBaseQty} 件）；只比两侧都有数据的月（比较 ${sales.comparedMonths.length > 0 ? sales.comparedMonths.join("、") : "无"}；内部缺月 ${sales.skippedMonths.length > 0 ? sales.skippedMonths.join("、") : "无"} 跳过不计）；仅覆盖天猫`),
        coverage: { from: jobCoverage.from, through: jobCoverage.through, basis: "该类连接器批次 source_as_of 起止" },
      };
    }
    return {
      sourceClass: cls, label: def.label, templates: templatesOfClass(cls),
      timeliness: timeliness(jobCoverage.latestAsOf, today, def.freshnessMaxAgeDays, "该类导入任务最新 source_as_of / 创建日"),
      completeness,
      uniqueness: { rate: null, n: 0, duplicates: 0, basis: "不度量：维表/对照表以主档 UNIQUE 与身份认领唯一入口约束" },
      accuracy: accuracy(null, 0, null, def.accuracyBasis),
      coverage: { from: jobCoverage.from, through: jobCoverage.through, basis: "该类导入任务 source_as_of / 创建日起止" },
    };
  });

  return {
    version: DATA_QUALITY_CACHE_KEY,
    authority: "observation_only",
    today,
    tolerancePct,
    windows: { reconDays: DQ_RECON_WINDOW_DAYS, countDays: DQ_COUNT_WINDOW_DAYS },
    sources,
    recon,
    count,
    snapshotQuality: snap,
    salesConsistency: {
      state: sales.state, consistencyPct: sales.consistencyPct, comparedRows: sales.comparedRows,
      exceptionRows: sales.exceptionRows, belowFloorRows: sales.belowFloorRows, anchorDate: sales.anchorDate,
      comparedMonths: sales.comparedMonths, skippedMonths: sales.skippedMonths, partialMonths: sales.partialMonths, thresholds: sales.thresholds,
    },
    manualOverrides: overrides,
    reviews: { pending: intValue(pendingRow?.n), currentWeek: isoWeekKey(today), currentMonth: monthKey(today) },
    unregisteredTemplates: unregistered,
    limitations: [
      "各维度只算能算的；算不出的留空并写明原因，不做综合分、不补 0。",
      "盘点命中率把未改动行计为命中，偏高；仅实时仓已审批盘点单。",
      "RPA 仓库栏的准确率来源是自有实时仓出库（stock_ledger sales_out）vs 聚水潭日销的 SKU 日级一致率，不是快照仓本身；快照仓只有相邻批次跳变与盘点命中率可佐证。",
      "外部平台准确率是两套口径的一致率，不裁定谁对；只比两侧都有数据的完整月，内部缺月跳过不记为不一致；目前仅覆盖天猫，拼多多/唯品会不度量；观察数据不进过账、不定量。",
      "本期手工改写指标数独立计数，不进任何准确率分子分母。",
    ],
  };
}

async function binding(db: ReadDb, today: string): Promise<string> {
  const [row] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT (SELECT coalesce(max(id), 0) FROM import_jobs) AS ij,
           (SELECT coalesce(max(id), 0) FROM integration_runs) AS ir,
           (SELECT coalesce(max(id), 0) FROM recon_diffs) AS rd,
           (SELECT count(*) FROM recon_diffs) AS rdn,
           (SELECT coalesce(max(id), 0) FROM pd_docs) AS pd,
           (SELECT coalesce(max(id), 0) FROM stock_snapshots) AS ss,
           (SELECT coalesce(max(id), 0) FROM sales_amount_monthly) AS sam,
           (SELECT coalesce(max(id), 0) FROM sales_monthly) AS sm,
           (SELECT count(*) FROM data_quality_reviews WHERE status = 'pending') AS dqp,
           (SELECT coalesce(max(id), 0) FROM data_quality_reviews) AS dqm,
           (SELECT coalesce(max(id), 0) FROM sys_params) AS sp,
           (SELECT count(*) FROM po_docs) AS po
  `));
  const tol = await getNumParam("dq_tolerance_pct", 1, db);
  return `d:${today}|ij:${intValue(row?.ij)}|ir:${intValue(row?.ir)}|rd:${intValue(row?.rd)}:${intValue(row?.rdn)}|pd:${intValue(row?.pd)}|ss:${intValue(row?.ss)}|sam:${intValue(row?.sam)}|sm:${intValue(row?.sm)}|dq:${intValue(row?.dqp)}:${intValue(row?.dqm)}|sp:${intValue(row?.sp)}|po:${intValue(row?.po)}|tol:${tol}`;
}

export async function loadDataQuality(db: ReadDb, opts: { today?: string } = {}): Promise<DataQualityReport> {
  const today = opts.today ?? todayShanghai();
  const key = await binding(db, today);
  const [cached] = rows<Record<string, unknown>>(await db.execute(sql`
    SELECT payload FROM report_read_model_cache WHERE key = ${DATA_QUALITY_CACHE_KEY} AND source_binding = ${key} LIMIT 1`));
  const payload = cached?.payload;
  const parsed = typeof payload === "string" ? (() => { try { return JSON.parse(payload); } catch { return null; } })() : payload;
  if (parsed && typeof parsed === "object" && (parsed as Partial<DataQualityReport>).version === DATA_QUALITY_CACHE_KEY
    && Array.isArray((parsed as Partial<DataQualityReport>).sources)) {
    return parsed as DataQualityReport;
  }
  return refreshDataQuality(db, { today });
}

export async function refreshDataQuality(db: ReadDb, opts: { today?: string } = {}): Promise<DataQualityReport> {
  const today = opts.today ?? todayShanghai();
  const key = await binding(db, today);
  const result = await computeDataQuality(db, { today });
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${DATA_QUALITY_CACHE_KEY}, ${key}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET source_binding = excluded.source_binding, payload = excluded.payload, built_at = excluded.built_at
  `);
  return result;
}
