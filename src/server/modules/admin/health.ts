/**
 * 运维面板数据装配（仅 admin；/api/admin/health）：
 * db/迁移状态（与 /api/health 同口径）、任务运行史（job_runs 每任务最新一条）、
 * 最近错误（error_logs 10 条）、最近导入（import_jobs 5 条）、导出队列积压、
 * 快照仓数据龄、备份新鲜度（BACKUP_DIR 或 ops 默认 ./backups；目录缺失=null，开发环境正常）。
 * 只读装配，不写库、不写审计。
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { errorLogs, exportJobs, importJobs, jobRuns, stockSnapshots, warehouses } from "@/db/schema";
import { getConnectorReadiness, type ConnectorReadiness } from "@/server/integrations/connector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export const SNAPSHOT_AGE_RED_DAYS = 3;
export const BACKUP_STALE_HOURS = 25; // 与 ops/check-backup.sh 同口径（02:30 调度留 1h 余量）

export interface JobRunRow {
  job: string;
  ok: boolean;
  message: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface ErrorLogRow {
  id: number;
  errorId: string;
  path: string | null;
  method: string | null;
  userId: number | null;
  message: string;
  createdAt: string;
}

export interface OpsHealth {
  generatedAt: string;
  dbOk: boolean;
  migrations: { files: number; applied: number; drift: boolean };
  lastJobRuns: JobRunRow[];
  recentErrors: ErrorLogRow[];
  errorCount24h: number;
  recentImports: {
    id: number;
    template: string;
    filename: string;
    status: string;
    okRows: number;
    failRows: number;
    createdAt: string;
  }[];
  exportQueue: { pending: number; running: number };
  snapshotAges: { warehouseId: number; code: string; name: string; latestBizDate: string | null; ageDays: number | null }[];
  /** null=备份目录不存在（开发环境正常） */
  backupFreshness: { dir: string; file: string; mtime: string; ageHours: number } | null;
  connectors: ConnectorReadiness[];
}

function todayShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function diffDays(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);
}

/** 备份新鲜度：目录内最新文件 mtime；目录缺失/为空 → null */
export function readBackupFreshness(dirOverride?: string): OpsHealth["backupFreshness"] {
  const dir = dirOverride ?? process.env.BACKUP_DIR ?? path.join(process.cwd(), "backups");
  try {
    const files = readdirSync(dir).filter((f) => !f.startsWith("."));
    let newest: { file: string; mtime: number } | null = null;
    for (const f of files) {
      try {
        const st = statSync(path.join(dir, f));
        if (st.isFile() && (!newest || st.mtimeMs > newest.mtime)) newest = { file: f, mtime: st.mtimeMs };
      } catch {
        /* 单文件读失败跳过 */
      }
    }
    if (!newest) return null;
    return {
      dir,
      file: newest.file,
      mtime: new Date(newest.mtime).toISOString(),
      ageHours: Math.round(((Date.now() - newest.mtime) / 3600000) * 10) / 10,
    };
  } catch {
    return null; // 目录不存在——开发环境正常
  }
}

export async function getOpsHealth(dbArg?: AnyDb): Promise<OpsHealth> {
  const db: AnyDb = dbArg ?? (await getDbAsync());

  // db + 迁移（与 /api/health 同口径：文件数 vs _migrations 已应用数；PG 模式 applied=-2）
  let dbOk = true;
  let applied = -1;
  let files = 0;
  try {
    files = readdirSync(path.resolve(process.cwd(), "drizzle")).filter((f) => f.endsWith(".sql")).length;
  } catch {
    files = -1;
  }
  try {
    await db.execute(sql`SELECT 1`);
    try {
      const r = await db.execute(sql`SELECT count(*)::int AS c FROM _migrations`);
      applied = Number((r.rows?.[0] as { c?: number })?.c ?? -1);
    } catch {
      applied = -2; // 非 PGlite（PG 走 drizzle-kit migrate，无 _migrations 表）
    }
  } catch {
    dbOk = false;
  }
  const drift = applied >= 0 && files >= 0 && applied < files;

  // job_runs：近 200 条内每任务最新一条
  const runRows: (typeof jobRuns.$inferSelect)[] = await db
    .select()
    .from(jobRuns)
    .orderBy(desc(jobRuns.finishedAt), desc(jobRuns.id))
    .limit(200);
  const seen = new Set<string>();
  const lastJobRuns: JobRunRow[] = [];
  for (const r of runRows) {
    if (seen.has(r.job)) continue;
    seen.add(r.job);
    lastJobRuns.push({
      job: r.job,
      ok: r.ok,
      message: r.message,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt.toISOString(),
    });
  }

  // 最近错误 10 条 + 24h 计数
  const errRows: (typeof errorLogs.$inferSelect)[] = await db
    .select()
    .from(errorLogs)
    .orderBy(desc(errorLogs.id))
    .limit(10);
  const [{ c: errorCount24h }] = (await db
    .select({ c: sql<number>`count(*)::int` })
    .from(errorLogs)
    .where(sql`${errorLogs.createdAt} > now() - interval '24 hours'`)) as { c: number }[];

  // 最近导入 5 条
  const importRows: (typeof importJobs.$inferSelect)[] = await db
    .select()
    .from(importJobs)
    .orderBy(desc(importJobs.id))
    .limit(5);

  // 导出队列积压
  const exportCounts: { status: string; c: number }[] = await db
    .select({ status: exportJobs.status, c: sql<number>`count(*)::int` })
    .from(exportJobs)
    .groupBy(exportJobs.status);
  const exportQueue = {
    pending: exportCounts.find((r) => r.status === "pending")?.c ?? 0,
    running: exportCounts.find((r) => r.status === "running")?.c ?? 0,
  };

  // 快照仓数据龄（全部快照仓，不设阈值过滤——阈值高亮由前端做）
  const latestSq = db
    .select({
      warehouseId: stockSnapshots.warehouseId,
      maxDate: sql<string>`max(${stockSnapshots.bizDate})`.as("max_date"),
    })
    .from(stockSnapshots)
    .groupBy(stockSnapshots.warehouseId)
    .as("latest");
  const snapRows: { id: number; code: string; name: string; latest: string | null }[] = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, latest: latestSq.maxDate })
    .from(warehouses)
    .leftJoin(latestSq, eq(latestSq.warehouseId, warehouses.id))
    .where(sql`${warehouses.accountingMode} = 'snapshot' AND ${warehouses.active} = true`);
  const today = todayShanghai();
  const snapshotAges = snapRows.map((r) => ({
    warehouseId: r.id,
    code: r.code,
    name: r.name,
    latestBizDate: r.latest,
    ageDays: r.latest ? diffDays(r.latest, today) : null,
  }));

  return {
    generatedAt: new Date().toISOString(),
    dbOk,
    migrations: { files, applied, drift },
    lastJobRuns,
    recentErrors: errRows.map((r) => ({
      id: r.id,
      errorId: r.errorId,
      path: r.path,
      method: r.method,
      userId: r.userId,
      message: r.message,
      createdAt: r.createdAt.toISOString(),
    })),
    errorCount24h,
    recentImports: importRows.map((r) => ({
      id: r.id,
      template: r.template,
      filename: r.filename,
      status: r.status,
      okRows: r.okRows,
      failRows: r.failRows,
      createdAt: r.createdAt.toISOString(),
    })),
    exportQueue,
    snapshotAges,
    backupFreshness: readBackupFreshness(),
    connectors: getConnectorReadiness(),
  };
}

/** 错误留档列表（/api/admin/errors；limit 上限 200） */
export async function listErrorLogs(limit = 50, dbArg?: AnyDb): Promise<ErrorLogRow[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const n = Math.min(200, Math.max(1, Math.trunc(limit) || 50));
  const rows: (typeof errorLogs.$inferSelect)[] = await db
    .select()
    .from(errorLogs)
    .orderBy(desc(errorLogs.id))
    .limit(n);
  return rows.map((r) => ({
    id: r.id,
    errorId: r.errorId,
    path: r.path,
    method: r.method,
    userId: r.userId,
    message: r.message,
    createdAt: r.createdAt.toISOString(),
  }));
}
