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
  "inventory-position-refresh": "25 11,17 * * *",
  "inventory-cover-watchdog": "35 11,17 * * *",
  "sales-spike-watchdog": "40 11,17 * * *",
  "transfer-cost-watchdog": "45 11,17 * * *",
  // W2 审计 5：证照到期 / 交期承诺违约 / OTIF 崩塌 / 质量案件逾期——必须排在
  // purchase-order-metrics 之后（OTIF 崩塌读的是那个读模型），故放在 11/17 点批次末尾
  "procurement-quality-alerts": "50 11,17 * * *",
  "todo-sync": "5,35 * * * *",
  "goals-auto-actuals": "15 6 * * *",
  "purchase-order-metrics": "10 2 * * *",
  "supplier-payment-term": "20 2 * * *",
  "weekly-dq-pack": "0 7 * * *",
  "planning-policy-build": "0 3 * * *",

  // 同步前半小时探测权限，便于把“未授权”与“同步代码失败”分开。
  "probe-jst-permissions": "30 9,15 * * *",
  "probe-yonyou-permissions": "35 9,15 * * *",

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
  // 审阅修复：投递必须排在 :35/:40/:45 的三只引擎看门狗之后，否则本轮新开的断货/爆单/调拨成本告警要等下一轮才送到人手上
  "system-alert-notify": "50 11,17 * * *",
  "notify-dispatch": "55 11,17 * * *",
  "exception-notify": "40 11 * * *",

  "jst-token-watchdog": "10 9 * * *",
  "data-freshness": "0 1 * * *",
  housekeeping: "30 1 * * *",
  rollup: "0 2 * * *",
  // 告警结果核验只读流水，排在 rollup 之后、白天同步之前
  "alert-outcome": "30 5 * * *",
  "decision-digest": "45 11 * * 1",
};

export async function start(): Promise<{ stop: () => Promise<void> } | null> {
  if (process.env.NODE_ENV === "test" || process.env.SCM_RUN_JOBS === "0") return null;
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
      /* 「另一处已经在跑」不是失败：抛出去会被 pg-boss 记成任务故障，
         连续几次就把失败看门狗叫醒，而实际上任务好好的、只是被互斥挡了一次
         （互斥点是 job_locks，见 interval-runner；手动触发与本 worker 共用同一把锁）。 */
      if (result.lock !== "acquired") return;
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
  if (process.env.NODE_ENV === "test" || process.env.SCM_RUN_JOBS === "0") return Promise.resolve(null);
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
