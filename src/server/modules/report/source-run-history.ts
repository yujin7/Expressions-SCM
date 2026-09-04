/**
 * C6 / B8 数据来源运行史（近 8 周，按 D65 来源类分组）。
 *
 * 不建历史表：`data-quality/v2` 是时点快照，趋势一律从既有运行史推导——
 * `import_jobs`（人工上传 + 连接器落库的批次：template / source_as_of / ok_rows / fail_rows）
 * 与 `integration_runs`（连接器每次运行的成功/失败，data-source-readiness 用的同一张表）。
 *
 * 两条序列，同一份运行史：
 * - C6 及时性：每周 `maxAgeDays` = 该周落库批次中「收到日 − 业务截止日(source_as_of)」的最大值，
 *   即「那一周最陈旧的一次入库」。没有 source_as_of 的批次不参与（不按 0 处理）。
 * - B8 数据质量：每周放行率 = Σok_rows ÷ (Σok_rows + Σfail_rows)（与 `dataAccuracyManual` 的
 *   staging 首次通过率同一口径，仍是代理指标），并列该周失败运行数。
 *
 * 判定：某来源类在 8 周窗口内有运行的周数 < 3 时整条序列 insufficient（三个点以下不叫趋势）。
 * **逐指标判定**（审计 C8b）：这份序列同时喂两张图，而「有运行」不等于「这张图画得出线」——
 * 有运行但批次全都没有 source_as_of，及时性图一个点都没有；ok/fail 全为 0（连接器只跑不落行），
 * 放行率图同样是空的。此前两张图共用 `state`，于是「ready 的 chip + 空白的图」同时出现。
 * 故按各自实际绘制的读数单独给 `ageState` / `passRateState`，`state`（有运行）只作总体活跃度参考。
 * 周起点按 Asia/Shanghai 的周一（date_trunc('week')）。
 */
import { sql } from "drizzle-orm";
import {
  IMPORT_TEMPLATE_SOURCE_CLASS,
  JDY_CONTRACT_SOURCE_CLASS,
  SOURCE_CLASSES,
  SOURCE_CLASS_DEFS,
  type SourceClass,
} from "@/server/core/data-source-class";
import { type AnyDb } from "@/server/core/svc";

export const SOURCE_RUN_HISTORY_WEEKS = 8;
/** 少于 3 周有运行 → 不出趋势（两个点连成的线不是趋势） */
export const SOURCE_RUN_HISTORY_MIN_WEEKS = 3;

export interface SourceWeekPoint {
  /** 周一（YYYY-MM-DD，Asia/Shanghai） */
  week: string;
  /** 该周落库批次数 */
  jobs: number;
  /** 该周连接器运行数 / 其中失败数 */
  runs: number;
  failedRuns: number;
  okRows: number;
  rejectedRows: number;
  /** 放行率 %（1dp）；分母 0 → null，不按 100% 处理 */
  passRatePct: number | null;
  /** 该周最陈旧的一次入库（收到日 − source_as_of，天）；无带业务截止日的批次 → null */
  maxAgeDays: number | null;
  /** 带 source_as_of 的批次数（maxAgeDays 的样本量） */
  datedJobs: number;
}

export interface SourceClassSeries {
  sourceClass: SourceClass;
  label: string;
  /** D65 登记的及时性阈值（天），用于在图上画基准线 */
  freshnessMaxAgeDays: number;
  points: SourceWeekPoint[];
  /** 8 周里有运行（批次或连接器运行）的周数 */
  weeksWithActivity: number;
  /** 有 maxAgeDays 读数的周数（C6 及时性图实际画得出点的周数） */
  weeksWithAge: number;
  /** 有 passRatePct 读数的周数（B8 数据质量图实际画得出点的周数） */
  weeksWithPassRate: number;
  /** 有运行的周数是否够（总体活跃度；**不代表任一张图画得出来**，图请看 ageState / passRateState） */
  state: "ready" | "insufficient";
  /** C6 及时性趋势能否成线（按 weeksWithAge 判） */
  ageState: "ready" | "insufficient";
  /** B8 放行率趋势能否成线（按 weeksWithPassRate 判） */
  passRateState: "ready" | "insufficient";
  gate: string | null;
  /** 及时性图不足时的原因（ready 时 null） */
  ageGate: string | null;
  /** 放行率图不足时的原因（ready 时 null） */
  passRateGate: string | null;
}

export interface SourceRunHistory {
  builtAt: string;
  windowWeeks: number;
  minWeeks: number;
  /** 8 个周一（升序） */
  weeks: string[];
  series: SourceClassSeries[];
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function intOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 该日所属周的周一（UTC 算术；入参已是 Asia/Shanghai 日期字符串） */
export function mondayOf(dayISO: string): string {
  const t = Date.parse(`${dayISO}T00:00:00Z`);
  const dow = new Date(t).getUTCDay(); // 0=周日
  const back = (dow + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

/** 以 today 所属周为最后一周，往回 n 周的周一列表（升序） */
export function weekKeys(todayISO: string, n: number): string[] {
  const last = Date.parse(`${mondayOf(todayISO)}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(last - (n - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10));
}

/** 数据流 key（integration_runs.stream）→ 来源类：简道云契约表优先，其余按导入模板名兜底 */
function classOfStream(stream: string, template: string | null): SourceClass | null {
  if (template) {
    const byTemplate = IMPORT_TEMPLATE_SOURCE_CLASS[template];
    if (byTemplate) return byTemplate;
  }
  return JDY_CONTRACT_SOURCE_CLASS[stream] ?? null;
}

interface Bucket {
  jobs: number;
  runs: number;
  failedRuns: number;
  okRows: number;
  rejectedRows: number;
  maxAgeDays: number | null;
  datedJobs: number;
}
const emptyBucket = (): Bucket => ({ jobs: 0, runs: 0, failedRuns: 0, okRows: 0, rejectedRows: 0, maxAgeDays: null, datedJobs: 0 });

export async function loadSourceRunHistory(db: AnyDb, opts: { today: string }): Promise<SourceRunHistory> {
  const weeks = weekKeys(opts.today, SOURCE_RUN_HISTORY_WEEKS);
  const from = weeks[0];
  const buckets = new Map<string, Bucket>(); // `${sourceClass}|${week}`
  const at = (cls: SourceClass, week: string): Bucket => {
    const key = `${cls}|${week}`;
    const b = buckets.get(key) ?? emptyBucket();
    buckets.set(key, b);
    return b;
  };

  const jobRows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT to_char(date_trunc('week', (created_at AT TIME ZONE 'Asia/Shanghai')), 'YYYY-MM-DD') AS week,
           template,
           count(*)::int AS jobs,
           coalesce(sum(ok_rows), 0)::int AS ok_rows,
           coalesce(sum(fail_rows), 0)::int AS fail_rows,
           count(source_as_of)::int AS dated_jobs,
           max(((created_at AT TIME ZONE 'Asia/Shanghai')::date - source_as_of))::int AS max_age_days
    FROM import_jobs
    WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date >= ${from}::date
    GROUP BY 1, 2
  `));
  for (const r of jobRows) {
    const week = String(r.week ?? "").slice(0, 10);
    if (!weeks.includes(week)) continue;
    const cls = IMPORT_TEMPLATE_SOURCE_CLASS[String(r.template ?? "")];
    if (!cls) continue; // 未登记模板由数据质量页单列告警，不猜归类
    const b = at(cls, week);
    b.jobs += int(r.jobs);
    b.okRows += int(r.ok_rows);
    b.rejectedRows += int(r.fail_rows);
    b.datedJobs += int(r.dated_jobs);
    const age = intOrNull(r.max_age_days);
    if (age != null) b.maxAgeDays = b.maxAgeDays == null ? age : Math.max(b.maxAgeDays, age);
  }

  const runRows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT to_char(date_trunc('week', (ir.started_at AT TIME ZONE 'Asia/Shanghai')), 'YYYY-MM-DD') AS week,
           ir.stream AS stream,
           ij.template AS template,
           count(*)::int AS runs,
           count(*) FILTER (WHERE ir.status = 'failed')::int AS failed_runs
    FROM integration_runs ir
    LEFT JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE (ir.started_at AT TIME ZONE 'Asia/Shanghai')::date >= ${from}::date
    GROUP BY 1, 2, 3
  `));
  for (const r of runRows) {
    const week = String(r.week ?? "").slice(0, 10);
    if (!weeks.includes(week)) continue;
    const cls = classOfStream(String(r.stream ?? ""), r.template == null ? null : String(r.template));
    if (!cls) continue;
    const b = at(cls, week);
    b.runs += int(r.runs);
    b.failedRuns += int(r.failed_runs);
  }

  const series: SourceClassSeries[] = SOURCE_CLASSES.map((cls) => {
    const def = SOURCE_CLASS_DEFS[cls];
    const points: SourceWeekPoint[] = weeks.map((week) => {
      const b = buckets.get(`${cls}|${week}`) ?? emptyBucket();
      const denom = b.okRows + b.rejectedRows;
      return {
        week,
        jobs: b.jobs,
        runs: b.runs,
        failedRuns: b.failedRuns,
        okRows: b.okRows,
        rejectedRows: b.rejectedRows,
        passRatePct: denom > 0 ? r1((b.okRows / denom) * 100) : null,
        maxAgeDays: b.maxAgeDays,
        datedJobs: b.datedJobs,
      };
    });
    const weeksWithActivity = points.filter((p) => p.jobs > 0 || p.runs > 0).length;
    const weeksWithAge = points.filter((p) => p.maxAgeDays != null).length;
    const weeksWithPassRate = points.filter((p) => p.passRatePct != null).length;
    const ready = weeksWithActivity >= SOURCE_RUN_HISTORY_MIN_WEEKS;
    const ageReady = weeksWithAge >= SOURCE_RUN_HISTORY_MIN_WEEKS;
    const passRateReady = weeksWithPassRate >= SOURCE_RUN_HISTORY_MIN_WEEKS;
    return {
      sourceClass: cls,
      label: def.label,
      freshnessMaxAgeDays: def.freshnessMaxAgeDays,
      points,
      weeksWithActivity,
      weeksWithAge,
      weeksWithPassRate,
      state: ready ? "ready" : "insufficient",
      ageState: ageReady ? "ready" : "insufficient",
      passRateState: passRateReady ? "ready" : "insufficient",
      gate: ready ? null : `近 ${SOURCE_RUN_HISTORY_WEEKS} 周只有 ${weeksWithActivity} 周有入库或运行，少于 ${SOURCE_RUN_HISTORY_MIN_WEEKS} 周不出趋势`,
      ageGate: ageReady
        ? null
        : `近 ${SOURCE_RUN_HISTORY_WEEKS} 周只有 ${weeksWithAge} 周有「收到日 − 业务截止日」读数（其余批次没有 source_as_of，不按 0 处理），少于 ${SOURCE_RUN_HISTORY_MIN_WEEKS} 周不出及时性趋势`,
      passRateGate: passRateReady
        ? null
        : `近 ${SOURCE_RUN_HISTORY_WEEKS} 周只有 ${weeksWithPassRate} 周有放行率读数（ok+fail 行为 0 的周留空，不按 100% 处理），少于 ${SOURCE_RUN_HISTORY_MIN_WEEKS} 周不出质量趋势`,
    };
  });

  return {
    builtAt: new Date().toISOString(),
    windowWeeks: SOURCE_RUN_HISTORY_WEEKS,
    minWeeks: SOURCE_RUN_HISTORY_MIN_WEEKS,
    weeks,
    series,
  };
}
