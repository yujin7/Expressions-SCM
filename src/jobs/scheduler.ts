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
  /*
   * 时区 Asia/Shanghai。**同步只在午饭前与傍晚前各一次**（2026-08-04 用户口径）：
   * 拉数是给人看的——上午下班前、下班前各刷新一次即可。原来每 6 小时一轮，
   * 深夜那两轮无人消费，白占三方接口配额（简道云单轮 8.5 万行、约 850 次分页、约 12 分钟）。
   *
   * 编排顺序：10:00 起依次拉数 → 11 点整跑对账/看门狗/告警投递，
   * 让本轮同步暴露的问题**当轮就送到人手上**，而不是等下一轮。傍晚同理（16 点拉、17 点推）。
   * 夜间维护类（freshness/housekeeping/rollup）不动，它们本就该在低峰跑。
   */
  "license-alert": "0 9 * * *",
  // 数据龄检查必须排在拉数**之后**：放 9:50 会在 10:00 同步刷新前十分钟
  // 天天报一次"数据过期"，制造每日假警报。改到两批同步之后各查一次。
  "snapshot-age": "5 11,17 * * *",

  // ── 午饭前批次：10 点拉数 → 11 点推告警 ──
  "sync-jiandaoyun-catalog": "0 10 * * *",
  "sync-yonyou": "5 10,16 * * *",
  "sync-jst-sales": "15 10,16 * * *",
  "sync-jst-item-master": "18 10,16 * * *",
  "sync-jst-inbound": "20 10,16 * * *",
  "sync-jst-inventory": "25 10,16 * * *",
  "sync-jiandaoyun-forms": "30 10,16 * * *",
  "reconcile-jst": "0 11,17 * * *",

  // ── 傍晚批次：16 点拉数 → 17 点推告警（catalog 每日一次即可，不重复拉）──
  // 同名任务无法登记两条 cron，故用「小时列表」表达两批：分钟相同、小时二选一
  "doc-aging": "10 11,17 * * *",
  "job-failure-watchdog": "20 11,17 * * *",
  "data-product-gate-watchdog": "22 11,17 * * *",
  "system-alert-notify": "25 11,17 * * *",
  "notify-dispatch": "30 11,17 * * *",
  "exception-notify": "40 11 * * *",

  "jst-token-watchdog": "10 9 * * *",
  "data-freshness": "0 1 * * *",
  housekeeping: "30 1 * * *",
  rollup: "0 2 * * *",
  "decision-digest": "45 11 * * 1",
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
