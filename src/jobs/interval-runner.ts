/**
 * 进程内定时任务回退（PGlite 开发/单机模式 pg_boss 不可用——否则计划任务永不触发）：
 * instrumentation register() 调 ensureIntervalJobsStarted()，globalThis 单例防
 * Next dev 热更新重复启动（与 export-worker ensureExportWorkerStarted 同型）。
 *
 * 本回退只允许在非 PostgreSQL（PGlite）模式启动；PostgreSQL 由 pg-boss 作为唯一
 * 调度权威。调用处和函数内各做一道防线，避免未来接线变化又产生双调度。
 *
 * 每次运行落 job_runs {job, ok, message≤500, startedAt, finishedAt}；首次 tick 延迟
 * 60s（避免拖慢冷启动）；NODE_ENV=test 直接 no-op。
 */
import { getDbAsync } from "@/db";
import { jobRuns } from "@/db/schema";
import { log } from "@/server/core/logger";
import { runLicenseAlert } from "./license-alert";
import { runReconcileJst, shanghaiToday } from "./reconcile-jst";
import { runSnapshotAgeAlert } from "./snapshot-age";
import { runHousekeeping } from "./housekeeping";
import { runFreshnessCheck } from "./freshness";
import { runDocAging } from "./doc-aging";
import { runRollup } from "./rollup";
import { dispatchNotifications, runDecisionDigestNotify, runExceptionNotify } from "./notify";
import {
  runJstGovernedObservationSync,
  runJstInventorySync,
  runJstSalesSync,
} from "./sync-jst";
import { runYonyouSync } from "./sync-yonyou";
import { runJstTokenWatchdog } from "./jst-token-watchdog";
import { runJobFailureWatchdog } from "./job-failure-watchdog";
import { runSystemAlertNotify } from "./system-alert-notify";
import { runDataProductGateWatchdog } from "./data-product-gate-watchdog";
import {
  runJiandaoyunCatalogSync,
  runJiandaoyunConfiguredFormSyncs,
} from "./sync-jiandaoyun";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const HOUR_MS = 3600 * 1000;
export const FIRST_TICK_DELAY_MS = 60 * 1000;

export interface IntervalJob {
  name: string;
  everyMs: number;
  /**
   * 只在这些「上海时区整点」跑（同一小时内只跑一次）。
   *
   * 业务口径（2026-08-04 用户确认）：**同步只需要在午饭前与傍晚前各一次**。
   * 拉数是给人看的——上午下班前和下班前各刷新一次就够，
   * 每 6 小时空跑一遍既无人消费，也白白占用三方接口配额
   * （简道云单轮 8.5 万行、约 850 次分页往返、耗时约 12 分钟）。
   *
   * 给了 atHours 时 everyMs 退化为**轮询间隔**（多久检查一次是否到点），
   * 不再是"每隔这么久跑一次"。
   */
  atHours?: number[];
  run: (db: AnyDb) => Promise<unknown>;
}

type IntervalJobRunOptions = {
  /** 运维恢复必须执行真实工作；缺配置/关闭开关形成的 skipped 不能冒充恢复。 */
  rejectSkipped?: boolean;
};

function skippedSummary(summary: unknown): { skipped: boolean; reason: string } {
  if (!summary || typeof summary !== "object" || !("status" in summary)) {
    return { skipped: false, reason: "" };
  }
  const candidate = summary as { status?: unknown; reason?: unknown };
  return candidate.status === "skipped"
    ? { skipped: true, reason: typeof candidate.reason === "string" ? candidate.reason : "任务返回 skipped" }
    : { skipped: false, reason: "" };
}

/**
 * 是否该在此刻执行——纯函数，便于直测。
 *
 * 抽出来的理由：这段判断原本埋在 `ensureIntervalJobsStarted` 的闭包里，
 * 而该函数在 NODE_ENV=test 下直接 return，等于**永远测不到**。
 * 定点执行一旦判错，后果是"该同步的时候没同步"——静默且不报错，
 * 正是最该有测试的那类逻辑。
 */
export function shouldRunAt(
  job: Pick<IntervalJob, "name" | "atHours">,
  now: Date,
  lastRunHour: ReadonlyMap<string, string>,
): { run: boolean; hourKey: string | null } {
  if (!job.atHours || job.atHours.length === 0) return { run: true, hourKey: null };
  const { hour, key } = shanghaiHourKey(now);
  if (!job.atHours.includes(hour)) return { run: false, hourKey: key };
  if (lastRunHour.get(job.name) === key) return { run: false, hourKey: key };
  return { run: true, hourKey: key };
}

/** 上海时区的「年-月-日 时」，用于判断是否到点、以及同一小时内不重复跑 */
export function shanghaiHourKey(now: Date): { hour: number; key: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  return { hour, key: `${get("year")}-${get("month")}-${get("day")}T${get("hour")}` };
}

export const INTERVAL_JOBS: IntervalJob[] = [
  // 快照数据龄告警（纯查询）——**必须排在拉数之后**，否则会在同步刷新前报一次假的"数据过期"
  { name: "snapshot-age", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runSnapshotAgeAlert(db) },
  // 营业执照到期提醒（纯查询）
  { name: "license-alert", everyMs: 6 * HOUR_MS, run: (db) => runLicenseAlert(db) },
  // 聚水潭 T-1 出库全量快照先进入受控 staging；缺配置时显式 skipped
  { name: "sync-jst-sales", everyMs: 20 * 60 * 1000, atHours: [10, 16], run: (db) => runJstSalesSync(db) },
  // 聚水潭商品与入库只读观察须显式选择契约；均停在 releaseBlocked staging。
  { name: "sync-jst-item-master", everyMs: 20 * 60 * 1000, atHours: [10, 16], run: (db) => runJstGovernedObservationSync(db, "item-master") },
  { name: "sync-jst-inbound", everyMs: 20 * 60 * 1000, atHours: [10, 16], run: (db) => runJstGovernedObservationSync(db, "inbound-receipts-daily") },
  // 聚水潭全仓合计库存增量只作外部观察；显式开关启用，绝不直写库存真账/快照
  { name: "sync-jst-inventory", everyMs: 20 * 60 * 1000, atHours: [10, 16], run: (db) => runJstInventorySync(db) },
  // 定时任务连续失败告警：job_runs 一直记着成败但没人被通知，
  // 对 6h 一跑的同步就是"三周前挂了没人知道"。连续 3 次才开单，避免抖动变噪音
  { name: "job-failure-watchdog", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runJobFailureWatchdog(db) },
  // 已批准的数据产品一旦因授权、时效、质量或范围变化降级，立即开责任域告警；恢复后自动关闭。
  { name: "data-product-gate-watchdog", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runDataProductGateWatchdog(db) },
  // 必须排在各看门狗之后，把本轮新开的 system_alerts 当轮推进飞书/站内。
  { name: "system-alert-notify", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runSystemAlertNotify(db) },
  // 聚水潭 token 30 天过期，且过期后刷新接口失效、只能重走授权——必须在还来得及时喊出来
  { name: "jst-token-watchdog", everyMs: 6 * HOUR_MS, run: (db) => runJstTokenWatchdog(db) },
  // 用友只读观测：按已批准契约拉数原样落 staging；缺配置/未开开关显式 skipped，
  // 契约未授权(310037)记为等授权而非故障，不推进 checkpoint
  { name: "sync-yonyou", everyMs: 20 * 60 * 1000, atHours: [10, 16], run: (db) => runYonyouSync(db) },
  // 简道云目录不含业务行；观察数据只拉显式契约、最小化字段并停在 staging
  { name: "sync-jiandaoyun-catalog", everyMs: 20 * 60 * 1000, atHours: [10], run: (db) => runJiandaoyunCatalogSync(db) },
  { name: "sync-jiandaoyun-forms", everyMs: 20 * 60 * 1000, atHours: [10, 16], run: (db) => runJiandaoyunConfiguredFormSyncs(db) },
  // 对 T-1 对账；无流水/无 staging 数据时返回空 summary（skuCount=0），自然优雅跳过
  { name: "reconcile-jst", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runReconcileJst(db, shanghaiToday(-1)) },
  // 保洁（删除幂等）
  { name: "housekeeping", everyMs: 24 * HOUR_MS, run: (db) => runHousekeeping(db) },
  // E7-01 预聚合物化（夜间全量重建，幂等 upsert）——BI 秒开 + 交期波动喂给安全库存
  { name: "rollup", everyMs: 24 * HOUR_MS, run: (db) => runRollup(db) },
  // 参考数据新鲜度看门狗（开/关 review_items 幂等）
  { name: "data-freshness", everyMs: 24 * HOUR_MS, run: (db) => runFreshnessCheck(db) },
  // 单据时效看门狗（等待态停留超阈值 → review_items，离开态自动关闭）
  { name: "doc-aging", everyMs: 6 * HOUR_MS, run: (db) => runDocAging(db) },
  // 异常入队（每日去重）+ 通知分发（飞书/站内）
  { name: "exception-notify", everyMs: 24 * HOUR_MS, run: (db) => runExceptionNotify(db) },
  { name: "decision-digest", everyMs: 7 * 24 * HOUR_MS, run: (db) => runDecisionDigestNotify(db) },
  { name: "notify-dispatch", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => dispatchNotifications(db) },
];

/** 跑一次并落 job_runs（job_runs 写失败仅打日志——监控不能反噬任务本身） */
export async function runIntervalJobOnce(
  job: IntervalJob,
  dbArg?: AnyDb,
  options?: IntervalJobRunOptions,
): Promise<{ ok: boolean; message: string; summary?: unknown; recorded: boolean }> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const startedAt = new Date();
  let ok = true;
  let message = "";
  let summary: unknown;
  try {
    summary = await job.run(db);
    try {
      message = JSON.stringify(summary) ?? "";
    } catch {
      message = String(summary);
    }
    const skipped = skippedSummary(summary);
    if (options?.rejectSkipped && skipped.skipped) {
      ok = false;
      message = `Skipped: ${skipped.reason}`;
    }
  } catch (e) {
    ok = false;
    message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log({ level: "error", msg: "interval job 失败", job: job.name, error: message });
  }
  message = message.slice(0, 500);
  let recorded = false;
  try {
    await db.insert(jobRuns).values({ job: job.name, ok, message, startedAt, finishedAt: new Date() });
    recorded = true;
  } catch (e) {
    log({ level: "warn", msg: "job_runs 落库失败", job: job.name, error: String(e) });
  }
  return { ok, message, summary, recorded };
}

/**
 * 运维手跑已登记任务的唯一入口。
 *
 * 直接调用任务函数虽能完成恢复，却不会写 job_runs；失败看门狗因此仍会把任务判作
 * 连续失败。这里复用同一任务目录和同一留痕路径，并把失败重新抛给 CLI，确保退出码非 0。
 */
export async function runNamedIntervalJobOnce(name: string, dbArg?: AnyDb): Promise<unknown> {
  const job = INTERVAL_JOBS.find((candidate) => candidate.name === name);
  if (!job) {
    throw new Error(`未知已登记任务: ${name}`);
  }
  const result = await runIntervalJobOnce(job, dbArg, { rejectSkipped: true });
  if (!result.recorded) {
    throw new Error(`任务 ${name} 已执行，但 job_runs 留痕失败，不能判定恢复`);
  }
  if (!result.ok) {
    throw new Error(result.message || `任务 ${name} 执行失败`);
  }
  return result.summary;
}

const RUNNER_KEY = Symbol.for("supply-chain.interval-runner");

/** 进程内单例启动（hot-reload 安全）；test 环境 no-op */
export function ensureIntervalJobsStarted(): void {
  if (process.env.NODE_ENV === "test") return;
  if ((process.env.DATABASE_URL ?? "").startsWith("postgres")) return;
  const g = globalThis as unknown as Record<symbol, { stop: () => void } | undefined>;
  if (g[RUNNER_KEY]) return;

  const timers: ReturnType<typeof setInterval>[] = [];
  const busy = new Set<string>();
  /** atHours 任务上次实际执行的「上海小时」键，防同一小时内重复跑 */
  const lastRunHour = new Map<string, string>();
  const tick = (job: IntervalJob): void => {
    if (busy.has(job.name)) return; // 重入保护：上一轮未结束不叠跑
    const decision = shouldRunAt(job, new Date(), lastRunHour);
    if (!decision.run) return; // 没到点，或这个小时已经跑过
    if (decision.hourKey) lastRunHour.set(job.name, decision.hourKey);
    busy.add(job.name);
    void runIntervalJobOnce(job)
      .catch((e: unknown) => log({ level: "error", msg: "interval runner 异常", job: job.name, error: String(e) }))
      .finally(() => busy.delete(job.name));
  };

  const boot = setTimeout(() => {
    for (const job of INTERVAL_JOBS) {
      tick(job); // 首轮
      const t = setInterval(() => tick(job), job.everyMs);
      t.unref?.();
      timers.push(t);
    }
    log({ level: "info", msg: "interval jobs started", jobs: INTERVAL_JOBS.map((j) => j.name) });
  }, FIRST_TICK_DELAY_MS);
  boot.unref?.();

  g[RUNNER_KEY] = {
    stop: () => {
      clearTimeout(boot);
      timers.forEach(clearInterval);
    },
  };
}
