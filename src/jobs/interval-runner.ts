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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const HOUR_MS = 3600 * 1000;
export const FIRST_TICK_DELAY_MS = 60 * 1000;

export interface IntervalJob {
  name: string;
  everyMs: number;
  run: (db: AnyDb) => Promise<unknown>;
}

export const INTERVAL_JOBS: IntervalJob[] = [
  // 快照数据龄告警（纯查询）——语义为每日，6h 一跑覆盖白天时段即可
  { name: "snapshot-age", everyMs: 6 * HOUR_MS, run: (db) => runSnapshotAgeAlert(db) },
  // 营业执照到期提醒（纯查询）
  { name: "license-alert", everyMs: 6 * HOUR_MS, run: (db) => runLicenseAlert(db) },
  // 对 T-1 对账；无流水/无 staging 数据时返回空 summary（skuCount=0），自然优雅跳过
  { name: "reconcile-jst", everyMs: 6 * HOUR_MS, run: (db) => runReconcileJst(db, shanghaiToday(-1)) },
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
  { name: "notify-dispatch", everyMs: 6 * HOUR_MS, run: (db) => dispatchNotifications(db) },
];

/** 跑一次并落 job_runs（job_runs 写失败仅打日志——监控不能反噬任务本身） */
export async function runIntervalJobOnce(
  job: IntervalJob,
  dbArg?: AnyDb,
): Promise<{ ok: boolean; message: string }> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const startedAt = new Date();
  let ok = true;
  let message = "";
  try {
    const summary = await job.run(db);
    try {
      message = JSON.stringify(summary) ?? "";
    } catch {
      message = String(summary);
    }
  } catch (e) {
    ok = false;
    message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log({ level: "error", msg: "interval job 失败", job: job.name, error: message });
  }
  message = message.slice(0, 500);
  try {
    await db.insert(jobRuns).values({ job: job.name, ok, message, startedAt, finishedAt: new Date() });
  } catch (e) {
    log({ level: "warn", msg: "job_runs 落库失败", job: job.name, error: String(e) });
  }
  return { ok, message };
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
  const tick = (job: IntervalJob): void => {
    if (busy.has(job.name)) return; // 重入保护：上一轮未结束不叠跑
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
