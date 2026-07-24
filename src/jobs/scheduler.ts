/* not covered by tests: requires real PG（pg_boss 依赖 Postgres 扩展语义，PGlite 不可用） */
/**
 * pg_boss 调度骨架（W5 接线；当前无任何调用方）：
 * 仅当 DATABASE_URL 为 postgres:// 时启用；PGlite 开发模式返回 null，
 * 任务改由 `npx tsx src/jobs/cli.ts <job>` 手跑（异步导出 worker 例外：
 * 由 /api/export/jobs 路由 ensureExportWorkerStarted() 进程内自启，PGlite/PG 通用）。
 * 计划（《02》§5，Asia/Shanghai）：reconcile-jst 每日 08:00（对 T-1）；license-alert 每日 07:00；
 * snapshot-age 每日 07:30（快照仓数据龄告警）；export-worker 进程内每 5s 轮询。
 */
import { getDbAsync } from "@/db";
import { runReconcileJst, shanghaiToday } from "./reconcile-jst";
import { runLicenseAlert } from "./license-alert";
import { runSnapshotAgeAlert } from "./snapshot-age";
import { ensureExportWorkerStarted } from "./export-worker";

const TZ = "Asia/Shanghai";
const Q_RECON = "reconcile-jst";
const Q_LICENSE = "license-alert";
const Q_SNAPSHOT_AGE = "snapshot-age";

export async function start(): Promise<{ stop: () => Promise<void> } | null> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) return null; // PGlite 开发模式：无调度器

  const { default: PgBoss } = await import("pg-boss");
  const boss = new PgBoss(url);
  boss.on("error", (err) => console.error("[pg_boss]", err));
  await boss.start();

  await boss.createQueue(Q_RECON);
  await boss.createQueue(Q_LICENSE);
  await boss.createQueue(Q_SNAPSHOT_AGE);
  await boss.schedule(Q_RECON, "0 8 * * *", {}, { tz: TZ });
  await boss.schedule(Q_LICENSE, "0 7 * * *", {}, { tz: TZ });
  await boss.schedule(Q_SNAPSHOT_AGE, "30 7 * * *", {}, { tz: TZ });

  await boss.work(Q_RECON, async () => {
    const db = await getDbAsync();
    const summary = await runReconcileJst(db, shanghaiToday(-1)); // 对 T-1 对账
    console.log("[reconcile-jst]", JSON.stringify(summary));
  });
  await boss.work(Q_LICENSE, async () => {
    const db = await getDbAsync();
    const summary = await runLicenseAlert(db);
    console.log("[license-alert]", JSON.stringify({ ...summary, alerts: summary.alertCount }));
  });
  await boss.work(Q_SNAPSHOT_AGE, async () => {
    const db = await getDbAsync();
    const summary = await runSnapshotAgeAlert(db);
    console.log("[snapshot-age]", JSON.stringify({ ...summary, alerts: summary.alertCount }));
  });

  // 异步导出 worker：进程内轮询（非 pg_boss 队列——认领语义在 export_jobs 表内自洽）
  ensureExportWorkerStarted();

  return { stop: () => boss.stop() };
}
