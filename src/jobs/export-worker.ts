/**
 * 异步导出 worker（UAT 缺口 #4）：export_jobs 表驱动，进程内轮询（PGlite/PG 通用，
 * 认领用「先选后条件更新」乐观锁，只有条件更新成功者执行任务）。
 * 行生产器复用 report/export.ts 的 EXPORT_KINDS（与同步导出同一套列/脱敏/截断语义）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { storageDir } from "@/server/core/storage";
import path from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { exportJobs, users } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { loadUserScopes } from "@/server/core/data-scope";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { log } from "@/server/core/logger";
import {
  buildCsv, EXPORT_KINDS, EXPORT_ROW_CAP, type ExportParams, stripMoneyColumns, SYNC_EXPORT_MAX,
} from "@/server/modules/report/export";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

async function resolveDb(db?: AnyDb): Promise<AnyDb> {
  return db ?? (await getDbAsync());
}

export const EXPORT_FILE_DIR = storageDir("exports");

export type ExportJobRecord = typeof exportJobs.$inferSelect;

export interface ExportJobRow {
  id: number;
  kind: string;
  status: string;
  rowCount: number | null;
  error: string | null;
  requestedBy: number;
  createdAt: string;
  finishedAt: string | null;
}

export function toJobRow(j: ExportJobRecord): ExportJobRow {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    rowCount: j.rowCount,
    error: j.error,
    requestedBy: j.requestedBy,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  };
}

export function requireExportRole(roles: string[], allowed?: readonly string[]): void {
  if (allowed?.length && !roles.includes("admin") && !allowed.some(role => roles.includes(role))) {
    throw new ApiError(403, "当前角色无权导出此类数据");
  }
}

/** Reserved worker evidence in the existing job JSON, never accepted from a client. */
export const EXPORT_ACCESS_KEY = "__generatedAccess";
export const exportFileHash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export function exportAccessFingerprint(user: SessionUser): string {
  return exportFileHash(JSON.stringify({ v: 1, id: user.id, roles: [...new Set(user.roles)].sort(),
    version: user.sessionVersion, approver: user.isApprover,
    channels: user.channelScope == null ? null : [...new Set(user.channelScope)].sort((a, b) => a - b),
    departments: user.deptScope == null ? null : [...new Set(user.deptScope)].sort() }));
}

/** Parent row lock shares the admin scope writer's boundary; no long producer/file work in this transaction. */
export async function loadExportUser(db: AnyDb, id: number): Promise<SessionUser> {
  return db.transaction(async (tx: AnyDb) => {
    const [u]: (typeof users.$inferSelect)[] = await tx.select().from(users).where(eq(users.id, id)).for("share");
    if (!u?.active) throw new ApiError(403, "申请人账号已停用或不存在");
    const scopes = await loadUserScopes(tx, u.id);
    return { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover,
      sessionVersion: u.sessionVersion, scopeVersion: u.sessionVersion, ...scopes };
  });
}

function exportRequestParams(params: ExportParams): ExportParams {
  return Object.fromEntries(Object.entries(params).filter(([key]) => key !== EXPORT_ACCESS_KEY));
}

/** 建任务（kind 必须已注册；params 须 JSON 可序列化）；writeAudit 留痕 */
export async function createExportJob(
  user: { id: number },
  kind: string,
  params: ExportParams,
  dbArg?: AnyDb,
): Promise<ExportJobRow> {
  const def = EXPORT_KINDS[kind];
  if (!def) throw new ApiError(400, `未知导出类型：${kind}`);
  params = exportRequestParams(params);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [current]: (typeof users.$inferSelect)[] = await tx.select().from(users).where(eq(users.id, user.id)).for("share");
    if (!current?.active) throw new ApiError(403, "申请人账号已停用或不存在");
    requireExportRole(current.roles, def.roles);
    const [row]: ExportJobRecord[] = await tx.insert(exportJobs)
      .values({ kind, params, requestedBy: current.id }).returning();
    await writeAudit(tx, {
      userId: current.id,
      entity: "export_job",
      entityId: row.id,
      action: "create",
      after: { kind, params },
    });
    return toJobRow(row);
  });
}

/** 同步导出闸门：total 超上限 → 自动建异步任务并返回 jobId；未超返回 null */
export async function syncExportGate(
  user: { id: number },
  kind: string,
  params: ExportParams,
  total: number,
  dbArg?: AnyDb,
): Promise<{ jobId: number } | null> {
  if (total <= SYNC_EXPORT_MAX) return null;
  const job = await createExportJob(user, kind, params, dbArg);
  return { jobId: job.id };
}

/** 我的任务列表（admin 可见全部）；最新在前，上限 100 行 */
export async function listExportJobs(
  user: { id: number; roles: string[] },
  dbArg?: AnyDb,
): Promise<(ExportJobRow & { requestedByName: string | null })[]> {
  const db = await resolveDb(dbArg);
  const isAdmin = user.roles.includes("admin");
  const rows: (ExportJobRecord & { requestedByName: string | null })[] = await db
    .select({
      id: exportJobs.id,
      kind: exportJobs.kind,
      params: exportJobs.params,
      status: exportJobs.status,
      filePath: exportJobs.filePath,
      rowCount: exportJobs.rowCount,
      error: exportJobs.error,
      requestedBy: exportJobs.requestedBy,
      createdAt: exportJobs.createdAt,
      finishedAt: exportJobs.finishedAt,
      requestedByName: users.name,
    })
    .from(exportJobs)
    .leftJoin(users, eq(exportJobs.requestedBy, users.id))
    .where(isAdmin ? undefined : eq(exportJobs.requestedBy, user.id))
    .orderBy(desc(exportJobs.id))
    .limit(100);
  return rows.map((r) => ({ ...toJobRow(r), requestedByName: r.requestedByName }));
}

/** 认领最旧 pending（乐观锁：UPDATE … WHERE status='pending' 防重复认领）；无任务返回 null */
export async function claimNextExportJob(dbArg?: AnyDb): Promise<ExportJobRecord | null> {
  const db = await resolveDb(dbArg);
  const [cand]: ExportJobRecord[] = await db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.status, "pending"))
    .orderBy(asc(exportJobs.createdAt), asc(exportJobs.id))
    .limit(1);
  if (!cand) return null;
  const [claimed]: ExportJobRecord[] = await db
    .update(exportJobs)
    .set({ status: "running" })
    .where(and(eq(exportJobs.id, cand.id), eq(exportJobs.status, "pending")))
    .returning();
  return claimed ?? null;
}

export interface ExportRunResult {
  id: number;
  kind: string;
  status: "done" | "failed";
  rowCount?: number;
  error?: string;
}

/**
 * 跑一个任务：认领 → 按 requestedBy 的**当前** DB 角色执行（脱敏/门禁与同步导出一致）→
 * 写 uploads/exports/<id>-<kind>.csv → done；任何异常 → failed + error。
 * 队列空返回 null。dirOverride 供测试写入临时目录。
 */
export async function runExportWorkerOnce(dbArg?: AnyDb, dirOverride?: string): Promise<ExportRunResult | null> {
  const db = await resolveDb(dbArg);
  const job = await claimNextExportJob(db);
  if (!job) return null;
  try {
    const def = EXPORT_KINDS[job.kind];
    if (!def) throw new ApiError(400, "未知导出类型，请重新创建导出任务");
    const runAs = await loadExportUser(db, job.requestedBy);
    requireExportRole(runAs.roles, def.roles);
    const params = exportRequestParams((job.params ?? {}) as ExportParams);
    const { rows, columns, total } = await def.produce(runAs, params, EXPORT_ROW_CAP, db);
    const csv = buildCsv(rows, stripMoneyColumns(columns, runAs.roles), { truncated: total > EXPORT_ROW_CAP });

    const dir = dirOverride ?? EXPORT_FILE_DIR;
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${job.id}-${job.kind}.csv`);
    await writeFile(filePath, csv, "utf8");

    await db
      .update(exportJobs)
      .set({ status: "done", filePath, rowCount: rows.length, finishedAt: new Date(),
        params: { ...params, [EXPORT_ACCESS_KEY]: { version: 1, identity: exportAccessFingerprint(runAs), sha256: exportFileHash(csv) } } })
      .where(eq(exportJobs.id, job.id));
    return { id: job.id, kind: job.kind, status: "done", rowCount: rows.length };
  } catch (e) {
    const errorId = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const businessError = e instanceof ApiError && e.status >= 400 && e.status < 500;
    const msg = businessError ? e.message : `导出失败，请联系管理员（错误码 ${errorId}）`;
    if (!businessError) log({ level: "error", msg: "导出任务失败", errorId, exportJobId: job.id, error: e });
    await db
      .update(exportJobs)
      .set({ status: "failed", error: msg.slice(0, 500), finishedAt: new Date() })
      .where(eq(exportJobs.id, job.id));
    return { id: job.id, kind: job.kind, status: "failed", error: msg };
  }
}

/** 轮询启动（默认 5s）；重入保护；返回 stop() */
export function startExportWorker(intervalMs = 5000): { stop: () => void } {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        // 一次醒来清空队列（任务通常量少；失败任务已置 failed 不会复取）
        while (await runExportWorkerOnce()) {
          /* drain */
        }
      } catch (e) {
        log({ level: "error", msg: "export worker error", error: e });
      } finally {
        busy = false;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * 开发模式（PGlite 无 pg_boss）进程内单例启动：由 /api/export/jobs 路由触达时调用。
 * globalThis 挂载防 Next dev 热更新重复启动；生产 PG 模式下 scheduler.start() 亦会调用（幂等）。
 */
const WORKER_KEY = Symbol.for("supply-chain.export-worker");

export function ensureExportWorkerStarted(): void {
  const g = globalThis as unknown as Record<symbol, { stop: () => void } | undefined>;
  if (g[WORKER_KEY]) return;
  g[WORKER_KEY] = startExportWorker(5000);
}
