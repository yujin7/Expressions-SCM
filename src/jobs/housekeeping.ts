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
import { and, eq, inArray, lt } from "drizzle-orm";
import { errorLogs, exportJobs, importJobs, jobRuns, stagingRows } from "@/db/schema";
import { EXPORT_FILE_DIR } from "./export-worker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export const STAGING_RETENTION_DAYS = 90;
export const EXPORT_RETENTION_DAYS = 30;
export const ERROR_LOG_RETENTION_DAYS = 90;
export const JOB_RUN_RETENTION_DAYS = 30;

export interface HousekeepingSummary {
  stagingRowsDeleted: number;
  exportJobsDeleted: number;
  exportFilesUnlinked: number;
  errorLogsDeleted: number;
  jobRunsDeleted: number;
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

  return {
    stagingRowsDeleted: delStaging.length,
    exportJobsDeleted: staleExports.length,
    exportFilesUnlinked: filesUnlinked,
    errorLogsDeleted: delErrors.length,
    jobRunsDeleted: delRuns.length,
  };
}
