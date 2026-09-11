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
 *
 * 并发互斥（2026-09-04 安全审计 S4）：唯一互斥点是 `job_locks` 表，抢锁在
 * `runIntervalJobOnce` 里——三条触发路径（pg-boss `boss.work`、下面这个回退定时器、
 * `/admin/health` 的「立即运行」）都经过它，所以它们**彼此**互斥，而不是各自跟自己互斥。
 * 下面闭包里的 `busy` Set 只是一层本地快速短路（省掉一次数据库往返），不是互斥依据。
 */
import { getDbAsync } from "@/db";
import { jobRuns } from "@/db/schema";
import { log } from "@/server/core/logger";
import { taskFailureMessage } from "./task-diagnostic";
import { acquireJobLock, releaseJobLock, type JobLockDenial, type JobLockHandle } from "./job-lock";
import { runLicenseAlert } from "./license-alert";
import { runProcurementQualityAlerts } from "./procurement-quality-alerts";
import { runReconcileJst, shanghaiToday } from "./reconcile-jst";
import { runSnapshotAgeAlert } from "./snapshot-age";
import { runInventoryPositionRefresh } from "./inventory-position-refresh";
import { runInventoryCoverWatchdog, runSalesSpikeWatchdog } from "./alert-watchdogs";
import { runAlertOutcome } from "./alert-outcome";
import { runTodoSync } from "./todo-sync";
import { runWeeklyDqPack } from "./weekly-dq-pack";
import { run as runTransferCostWatchdog } from "./transfer-cost-watchdog";
import { refreshAutoActuals } from "@/server/modules/goals/service";
import { refreshPurchaseOrderMetrics } from "@/server/modules/report/purchase-order-metrics";
import { refreshSupplierPaymentTerm } from "@/server/modules/report/supplier-payment-term";
import { runPolicyBuild } from "@/server/modules/planning/policy";
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
import { runJstPermissionProbe } from "./probe-jst";
import { runYonyouPermissionProbe } from "./probe-yonyou";
import { CONNECTOR_PROBE_VERSION } from "@/server/integrations/connector-probe-evidence";
import {
  runJiandaoyunCatalogSync,
  runJiandaoyunConfiguredFormSyncs,
} from "./sync-jiandaoyun";
import { shanghaiHourKeyOf } from "@/server/core/business-day";
import { yonyouJobSummary } from "@/lib/yonyou-job-summary";

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
  /**
   * 调用方已经持有 `job_locks` 里这个任务的锁（手动触发路径：它要在**释放锁之前**写审计）。
   * 缺省 false = 本函数自己抢锁并释放。
   */
  lockHeld?: boolean;
  /** 距上一轮结束不足此值即拒绝（只有手动触发用；调度器路径不设冷却） */
  cooldownMs?: number;
};

export interface IntervalJobRunResult {
  ok: boolean;
  message: string;
  summary?: unknown;
  recorded: boolean;
  /** 互斥结果：acquired=真的跑了；running/cooldown=没跑（也没写 job_runs） */
  lock: "acquired" | JobLockDenial;
  /** lock !== "acquired" 时还要等多久 */
  retryAfterMs: number;
}

/** 「这轮没跑，因为别处正在跑或还在冷却」——与「跑了但失败了」是两件事，不能混成一个 Error */
export class JobBusyError extends Error {
  readonly job: string;
  readonly reason: JobLockDenial;
  readonly retryAfterMs: number;
  constructor(job: string, reason: JobLockDenial, retryAfterMs: number, message: string) {
    super(message);
    this.name = "JobBusyError";
    this.job = job;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

function skippedSummary(summary: unknown): { skipped: boolean; reason: string } {
  if (!summary || typeof summary !== "object") {
    return { skipped: false, reason: "" };
  }
  const candidate = summary as { status?: unknown; reason?: unknown; v?: unknown; s?: unknown };
  if (candidate.status === "skipped") {
    return {
      skipped: true,
      reason: typeof candidate.reason === "string" ? candidate.reason : "任务返回 skipped",
    };
  }
  if (candidate.v === CONNECTOR_PROBE_VERSION && candidate.s === "skipped") {
    return { skipped: true, reason: "连接器权限探测因配置不完整未执行" };
  }
  return { skipped: false, reason: "" };
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
export const shanghaiHourKey = shanghaiHourKeyOf;

export const INTERVAL_JOBS: IntervalJob[] = [
  // 同步前先做最小只读权限探测；结果是无业务值的版本化证据，不代替 UAT。
  { name: "probe-jst-permissions", everyMs: 20 * 60 * 1000, atHours: [9, 15], run: () => runJstPermissionProbe() },
  { name: "probe-yonyou-permissions", everyMs: 20 * 60 * 1000, atHours: [9, 15], run: () => runYonyouPermissionProbe() },
  // 快照数据龄告警（纯查询）——**必须排在拉数之后**，否则会在同步刷新前报一次假的"数据过期"
  { name: "snapshot-age", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runSnapshotAgeAlert(db) },
  { name: "inventory-position-refresh", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runInventoryPositionRefresh(db) },
  { name: "inventory-cover-watchdog", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runInventoryCoverWatchdog(db) },
  { name: "sales-spike-watchdog", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runSalesSpikeWatchdog(db) },
  { name: "transfer-cost-watchdog", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runTransferCostWatchdog(db) },
  // W2 审计 5：证照到期 / 交期承诺违约 / OTIF 崩塌 / 质量案件逾期（四类别一次跑完）
  { name: "procurement-quality-alerts", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => runProcurementQualityAlerts(db) },
  { name: "todo-sync", everyMs: 30 * 60 * 1000, run: (db) => runTodoSync(db) },
  { name: "goals-auto-actuals", everyMs: 6 * HOUR_MS, atHours: [6], run: (db) => refreshAutoActuals(db) },
  { name: "purchase-order-metrics", everyMs: 6 * HOUR_MS, atHours: [2], run: (db) => refreshPurchaseOrderMetrics(db) },
  { name: "supplier-payment-term", everyMs: 6 * HOUR_MS, atHours: [2], run: (db) => refreshSupplierPaymentTerm(db) },
  { name: "weekly-dq-pack", everyMs: 6 * HOUR_MS, atHours: [7], run: (db) => runWeeklyDqPack(db) },
  // 每天 03:00 跑，但 runPolicyBuild 是幂等的：本期已固化即跳过——「冻结」才真的是冻结，
  // 不会因为每天重算而让同一期的四档天天漂（重算须由人工在分层页显式重建）。
  { name: "planning-policy-build", everyMs: 6 * HOUR_MS, atHours: [3], run: (db) => runPolicyBuild(db) },
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
  // 告警结果核验（闭环审计 #3）：关闭 ≥3 天的断货告警回看实时仓流水写 verify 事件；夜间低峰、排在 rollup 之后
  { name: "alert-outcome", everyMs: 24 * HOUR_MS, atHours: [5], run: (db) => runAlertOutcome(db) },
  // 参考数据新鲜度看门狗（开/关 review_items 幂等）
  { name: "data-freshness", everyMs: 24 * HOUR_MS, run: (db) => runFreshnessCheck(db) },
  // 单据时效看门狗（等待态停留超阈值 → review_items，离开态自动关闭）
  { name: "doc-aging", everyMs: 6 * HOUR_MS, run: (db) => runDocAging(db) },
  // 异常入队（每日去重）+ 通知分发（飞书/站内）
  { name: "exception-notify", everyMs: 24 * HOUR_MS, run: (db) => runExceptionNotify(db) },
  { name: "decision-digest", everyMs: 7 * 24 * HOUR_MS, run: (db) => runDecisionDigestNotify(db) },
  { name: "notify-dispatch", everyMs: 20 * 60 * 1000, atHours: [11, 17], run: (db) => dispatchNotifications(db) },
];

/**
 * 跑一次并落 job_runs（job_runs 写失败仅打日志——监控不能反噬任务本身）。
 *
 * **互斥在这里，不在调用方**（2026-09-04 安全审计 S4）：本函数是三条路径的公共下游
 * （pg-boss 的 `boss.work`、PGlite 回退定时器、`/admin/health` 的「立即运行」），
 * 把 `job_locks` 的抢锁放在这里，三条路径才真的互斥。此前三处各持一个进程内 `Set`，
 * 谁也拦不住谁——计划中的同步跑到一半时手动再点一次，同一个同步会真的跑两遍。
 *
 * 没抢到锁时**不执行、也不写 job_runs**：一次被拦下的重复触发不是一次任务运行，
 * 记进去只会污染失败看门狗的连续失败判定。
 */
export async function runIntervalJobOnce(
  job: IntervalJob,
  dbArg?: AnyDb,
  options?: IntervalJobRunOptions,
): Promise<IntervalJobRunResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  let lock: JobLockHandle | null = null;
  if (!options?.lockHeld) {
    const attempt = await acquireJobLock(db, job.name, { cooldownMs: options?.cooldownMs });
    if (!attempt.acquired) {
      return {
        ok: false,
        message: attempt.reason === "running"
          ? `任务 ${job.name} 正在运行中（另一处调度或手动触发已持有锁）`
          : `任务 ${job.name} 刚刚跑过，冷却中`,
        recorded: false,
        lock: attempt.reason,
        retryAfterMs: attempt.retryAfterMs,
      };
    }
    lock = attempt;
  }
  try {
    return await runJobBody(job, db, options);
  } finally {
    if (lock) await releaseJobLock(db, lock);
  }
}

async function runJobBody(job: IntervalJob, db: AnyDb, options?: IntervalJobRunOptions): Promise<IntervalJobRunResult> {
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
    const errorId = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    // Provider prose may contain credentials with no label; never try to recover it via regex.
    message = taskFailureMessage(job.name, e, errorId);
    log({ level: "error", msg: "interval job 失败", job: job.name, errorId, error: message });
  }
  // Preserve execution health for expected authorization waits. Persist a complete,
  // versioned allowlist instead of truncating results before the waiting evidence.
  message = job.name === "sync-yonyou"
    ? JSON.stringify(yonyouJobSummary(summary, ok))
    : message.slice(0, 500);
  let recorded = false;
  try {
    await db.insert(jobRuns).values({ job: job.name, ok, message, startedAt, finishedAt: new Date() });
    recorded = true;
  } catch (e) {
    log({ level: "warn", msg: "job_runs 落库失败", job: job.name, error: String(e) });
  }
  return { ok, message, summary, recorded, lock: "acquired", retryAfterMs: 0 };
}

/**
 * 运维手跑已登记任务的唯一入口。
 *
 * 直接调用任务函数虽能完成恢复，却不会写 job_runs；失败看门狗因此仍会把任务判作
 * 连续失败。这里复用同一任务目录和同一留痕路径，并把失败重新抛给 CLI，确保退出码非 0。
 */
export async function runNamedIntervalJobOnce(
  name: string,
  dbArg?: AnyDb,
  options?: Pick<IntervalJobRunOptions, "lockHeld" | "cooldownMs">,
): Promise<unknown> {
  const job = INTERVAL_JOBS.find((candidate) => candidate.name === name);
  if (!job) {
    throw new Error(`未知已登记任务: ${name}`);
  }
  const result = await runIntervalJobOnce(job, dbArg, { ...options, rejectSkipped: true });
  if (result.lock !== "acquired") {
    /* 「没抢到锁」不是一次失败的运行，也不是一次成功的恢复——它是「这轮没跑」。
       必须与执行失败区分开：CLI/手动路径据此给出 409 与等待时长，而不是把它记成任务故障。 */
    throw new JobBusyError(name, result.lock, result.retryAfterMs, result.message);
  }
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
  if (process.env.NODE_ENV === "test" || process.env.SCM_RUN_JOBS === "0") return;
  if ((process.env.DATABASE_URL ?? "").startsWith("postgres")) return;
  const g = globalThis as unknown as Record<symbol, { stop: () => void } | undefined>;
  if (g[RUNNER_KEY]) return;

  const timers: ReturnType<typeof setInterval>[] = [];
  /* 本地快速短路：省掉「上一轮还在跑」时的一次数据库往返。
     真正的互斥在 runIntervalJobOnce 的 job_locks 上——这个 Set 拦不住别的进程/调度器。 */
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
