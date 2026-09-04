/**
 * housekeeping（运维保洁，幂等可重跑——双调度并存时重复执行无害）：
 *  (a) superseded 且超 90 天的 import_jobs 的 staging_rows → 删除（保留任务头行，留审计口径）；
 *  (b) done/failed 且超 30 天的 export_jobs → 删 DB 行 + best-effort 删文件
 *      （路径守卫：仅删 uploads/exports 目录内文件，防 filePath 被污染后越界删除）；
 *  (c) error_logs 超 90 天删除；
 *  (d) job_runs 超 30 天删除。
 * 返回各项计数。opts.now / opts.exportDir 仅供测试注入。
 */
import { unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, lt, isNotNull, or, isNull } from "drizzle-orm";
import { errorLogs, exportJobs, importJobs, jobRuns, reportReadModelCache, stagingRows, notifications } from "@/db/schema";
import { EXPORT_FILE_DIR } from "./export-worker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export const STAGING_RETENTION_DAYS = 90;
export const EXPORT_RETENTION_DAYS = 30;
export const ERROR_LOG_RETENTION_DAYS = 90;
export const JOB_RUN_RETENTION_DAYS = 30;
/** 已读通知保留天数（未读永不自动删——不替用户决定什么该被忽略） */
const NOTIFY_READ_RETENTION_DAYS = 30;
/** 广播/角色定向通知的绝对保留天数（readAt 归属不明，只能按年龄兜底） */
const NOTIFY_BROADCAST_RETENTION_DAYS = 180;
/**
 * 读模型缓存保留期：口径升版（key 带 /vN）后旧键再无人读，但行会一直留着。
 * 缓存丢了只会重算，所以按绝对年龄兜底即可；窗口远大于任何一个读模型的重建周期。
 */
export const READ_MODEL_CACHE_RETENTION_DAYS = 60;

export interface HousekeepingSummary {
  stagingRowsDeleted: number;
  exportJobsDeleted: number;
  exportFilesUnlinked: number;
  errorLogsDeleted: number;
  jobRunsDeleted: number;
  /** 已读且超保留期的通知清理数 */
  notificationsDeleted: number;
  /** 超保留期的读模型缓存行（含口径升版后无人读的旧键） */
  readModelCacheDeleted: number;
}

const DAY_MS = 24 * 3600 * 1000;

export async function runHousekeeping(
  db: AnyDb,
  opts?: { now?: Date; exportDir?: string },
): Promise<HousekeepingSummary> {
  const now = opts?.now ?? new Date();
  const cutoff = (days: number): Date => new Date(now.getTime() - days * DAY_MS);

  // (a) superseded 超期任务的 staging 行（任务头行保留）
  const supersededOld = db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(and(eq(importJobs.status, "superseded"), lt(importJobs.createdAt, cutoff(STAGING_RETENTION_DAYS))));
  const delStaging: { id: number }[] = await db
    .delete(stagingRows)
    .where(inArray(stagingRows.importJobId, supersededOld))
    .returning({ id: stagingRows.id });

  // (b) 超期导出任务：先删文件（守卫在 exports 目录内），再删行
  const exportDir = path.resolve(opts?.exportDir ?? EXPORT_FILE_DIR);
  const staleExports: { id: number; filePath: string | null }[] = await db
    .select({ id: exportJobs.id, filePath: exportJobs.filePath })
    .from(exportJobs)
    .where(and(inArray(exportJobs.status, ["done", "failed"]), lt(exportJobs.createdAt, cutoff(EXPORT_RETENTION_DAYS))));
  let filesUnlinked = 0;
  for (const j of staleExports) {
    if (j.filePath) {
      const resolved = path.resolve(j.filePath);
      if (resolved.startsWith(exportDir + path.sep)) {
        try {
          await unlink(resolved);
          filesUnlinked++;
        } catch {
          /* 文件已不存在/无权限——best-effort */
        }
      }
    }
    await db.delete(exportJobs).where(eq(exportJobs.id, j.id));
  }

  // (c) error_logs 超 90 天
  const delErrors: { id: number }[] = await db
    .delete(errorLogs)
    .where(lt(errorLogs.createdAt, cutoff(ERROR_LOG_RETENTION_DAYS)))
    .returning({ id: errorLogs.id });

  // (d) job_runs 超 30 天
  const delRuns: { id: number }[] = await db
    .delete(jobRuns)
    .where(lt(jobRuns.finishedAt, cutoff(JOB_RUN_RETENTION_DAYS)))
    .returning({ id: jobRuns.id });

  /* (e) 通知保留期（2026-07-25 审计新增）。
     此前 notifications 表**无任何保留期**，只能人工「全部已读」，而列表硬截断 100 条
     且无分页——日推摘要按 3 条/天无衰减累积，约 33 天后占满唯一视图，
     真实事件通知被永久挤出。已读的留 30 天（回溯足够），未读不删（不替用户做决定）。 */
  /* readAt 是**行级**的，而一行可以被多人看见（广播 userId=null，或 targetRole 定向一个角色，
     且 admin 无 audience 过滤能看到全部）。所以 readAt 的真实语义是「**某个**能看到它的人读过」，
     不是「收件人读过」。首版按 readAt 一刀切删除，等于：定向 pmc 的通知只要被 admin 打开过，
     30 天后就会在 pmc01 从未看见的情况下被永久删除——我却在提交信息里写了「未读永不自动删」。
     那句话只在行级成立，在收件人级不成立。

     在不改 schema（需要 per-recipient 已读表）的前提下，按收件人可辨识性分两档：
      · userId 非空＝**唯一收件人**，readAt 就是那个人读的 → 按已读 30 天清理，语义准确；
      · userId 为空（广播/角色定向）＝ readAt 归属不明 → **不按已读删**，
        只按绝对年龄兜底，避免表无界增长，且窗口给得足够长。 */
  const delNotify: { id: number }[] = await db
    .delete(notifications)
    .where(
      or(
        and(
          isNotNull(notifications.userId),
          isNotNull(notifications.readAt),
          lt(notifications.readAt, cutoff(NOTIFY_READ_RETENTION_DAYS)),
        ),
        and(isNull(notifications.userId), lt(notifications.createdAt, cutoff(NOTIFY_BROADCAST_RETENTION_DAYS))),
      ),
    )
    .returning({ id: notifications.id });

  // 口径升版后的僵尸缓存行（如 inventory-alerts/v1 在 /v2 上线后再无人读）
  const delCache: { key: string }[] = await db
    .delete(reportReadModelCache)
    .where(lt(reportReadModelCache.builtAt, cutoff(READ_MODEL_CACHE_RETENTION_DAYS)))
    .returning({ key: reportReadModelCache.key });

  return {
    readModelCacheDeleted: delCache.length,
    stagingRowsDeleted: delStaging.length,
    exportJobsDeleted: staleExports.length,
    exportFilesUnlinked: filesUnlinked,
    errorLogsDeleted: delErrors.length,
    jobRunsDeleted: delRuns.length,
    notificationsDeleted: delNotify.length,
  };
}
