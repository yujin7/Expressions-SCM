/* Runtime integration requires real PG（pg_boss 依赖 Postgres 扩展语义，PGlite 不可用） */
/**
 * PostgreSQL 唯一计划任务权威：
 * - instrumentation 在 postgres:// 下只启动本调度器；不再同时启动 interval-runner；
 * - 全部任务来自 interval-runner 的唯一任务目录，执行统一写 job_runs；
 * - pg-boss 负责多实例抢占、重试与 cron 持久化，避免 Web 副本各自双跑；
 * - PGlite 才使用 interval-runner 回退。
 */
import { INTERVAL_JOBS, runIntervalJobOnce } from "./interval-runner";
import { ensureExportWorkerStarted } from "./export-worker";

const TZ = "Asia/Shanghai";
export const SCHEDULES: Record<string, string> = {
  "license-alert": "0 7 * * *",
  "snapshot-age": "30 7 * * *",
  "reconcile-jst": "0 8 * * *",
  "doc-aging": "15 */6 * * *",
  "notify-dispatch": "30 */6 * * *",
  "data-freshness": "0 1 * * *",
  housekeeping: "30 1 * * *",
  rollup: "0 2 * * *",
  "exception-notify": "30 8 * * *",
  "decision-digest": "45 8 * * 1",
};

export async function start(): Promise<{ stop: () => Promise<void> } | null> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) return null; // PGlite 开发模式：无调度器

  const { default: PgBoss } = await import("pg-boss");
  const boss = new PgBoss(url);
  boss.on("error", (err) => console.error("[pg_boss]", err));
  await boss.start();

  for (const job of INTERVAL_JOBS) {
    const cron = SCHEDULES[job.name];
    if (!cron) throw new Error(`缺少 pg-boss cron 配置: ${job.name}`);
    await boss.createQueue(job.name);
    await boss.schedule(job.name, cron, {}, { tz: TZ });
    await boss.work(job.name, async () => {
      const result = await runIntervalJobOnce(job);
      if (!result.ok) throw new Error(result.message);
    });
  }

  // 异步导出 worker：进程内轮询（非 pg_boss 队列——认领语义在 export_jobs 表内自洽）
  ensureExportWorkerStarted();

  return { stop: () => boss.stop() };
}

const SCHEDULER_KEY = Symbol.for("supply-chain.pg-boss-scheduler");

/** 进程内单例；多进程/多副本由 pg-boss 在数据库层协调。 */
export function ensureSchedulerStarted(): Promise<{ stop: () => Promise<void> } | null> {
  if (process.env.NODE_ENV === "test") return Promise.resolve(null);
  const g = globalThis as unknown as Record<
    symbol,
    Promise<{ stop: () => Promise<void> } | null> | undefined
  >;
  g[SCHEDULER_KEY] ??= start().catch((error) => {
    delete g[SCHEDULER_KEY];
    throw error;
  });
  return g[SCHEDULER_KEY];
}
