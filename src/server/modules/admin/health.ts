/**
 * 运维面板数据装配（仅 admin；/api/admin/health）：
 * db/迁移状态（与 /api/health 同口径）、任务运行史（job_runs 每任务最新一条）、
 * 最近错误（error_logs 10 条）、最近导入（import_jobs 5 条）、导出队列积压、
 * 快照仓数据龄、连接器最近运行/检查点、备份新鲜度（BACKUP_DIR 或 ops 默认
 * ./backups；目录缺失=null，开发环境正常）。
 * 只读装配，不写库、不写审计。
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import {
  aliasExceptions,
  aliases,
  errorLogs,
  exportJobs,
  importJobs,
  integrationCheckpoints,
  integrationRuns,
  jobRuns,
  skuIdentifiers,
  stockSnapshots,
  warehouses,
} from "@/db/schema";
import {
  getConnectorReadiness,
  type ConnectorIdentityEvidence,
  type ConnectorIdentityScope,
  type ConnectorReadiness,
} from "@/server/integrations/connector";

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

export interface ConnectorRunHealthRow {
  connector: string;
  stream: string;
  status: "running" | "succeeded" | "failed";
  sourceRows: number;
  stagedRows: number;
  rejectedRows: number;
  startedAt: string;
  finishedAt: string | null;
  sourceAsOf: string | null;
  schemaHashPrefix: string | null;
  unresolvedAliases: number | null;
  openScopedAliasExceptions: number;
  checkpointVersion: number | null;
  checkpointLastSuccessAt: string | null;
  checkpointAgeHours: number | null;
  checkpointOnLatestRun: boolean;
  /** Safe operational flags copied from the run envelope; no source payload is exposed. */
  emptySource: boolean;
  releaseBlocked: boolean;
  errorSummary: string | null;
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
  connectorRuns: ConnectorRunHealthRow[];
}

const ALIAS_SCOPE_BY_CONNECTOR: Readonly<Record<string, string>> = {
  jst: "JST",
  jdy: "JIANDAOYUN",
  yy: "YONYOU",
};

function scopeObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function sourceDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function schemaHashPrefix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[0-9a-f]{12,128}$/i.test(normalized) ? normalized.slice(0, 12).toLowerCase() : null;
}

/**
 * Do not return stored connector errors to the browser. They can contain source identifiers,
 * upstream URLs or credentials. The admin panel only needs a bounded remediation category;
 * exact diagnostics stay in the protected server log/evidence workflow.
 */
export function connectorErrorSummary(value: string | null): string | null {
  if (!value?.trim()) return null;
  const normalized = value.toLowerCase();
  let summary = "连接器运行失败（详情仅限受控日志）";
  if (/schema|contract|字段|契约|漂移/.test(normalized)) {
    summary = "字段契约或 schema 校验失败";
  } else if (/unauthori[sz]ed|forbidden|credential|token|auth|401|403|认证|授权|密钥/.test(normalized)) {
    summary = "外部系统认证或授权失败";
  } else if (/timeout|timed out|network|fetch|socket|econn|dns|超时|网络|连接/.test(normalized)) {
    summary = "外部服务连接或超时";
  } else if (/alias|别名|标识|解析/.test(normalized)) {
    summary = "外部标识或别名解析失败";
  } else if (/checkpoint|cursor|游标|检查点/.test(normalized)) {
    summary = "同步游标或检查点失败";
  } else if (/transaction|constraint|database|postgres|pglite|事务|约束|数据库/.test(normalized)) {
    summary = "受控落库事务失败";
  }
  return summary.slice(0, 80);
}

/**
 * error_logs and job_runs intentionally keep the original diagnostic text for protected
 * server-side investigation. The browser receives only a bounded category: upstream SDKs and
 * database drivers can embed tokens, URLs, source identifiers or SQL values in Error.message.
 */
export function operationalErrorSummary(value: string | null): string {
  const normalized = value?.toLowerCase() ?? "";
  if (/unauthori[sz]ed|forbidden|credential|token|auth|401|403|认证|授权|密钥/.test(normalized)) {
    return "认证或授权异常（详情仅限受控日志）";
  }
  if (/timeout|timed out|network|fetch|socket|econn|dns|超时|网络|连接/.test(normalized)) {
    return "外部服务连接或超时（详情仅限受控日志）";
  }
  if (/schema|contract|字段|契约|校验|validation/.test(normalized)) {
    return "数据契约或校验异常（详情仅限受控日志）";
  }
  if (/transaction|constraint|database|postgres|pglite|sql|事务|约束|数据库/.test(normalized)) {
    return "数据库或事务异常（详情仅限受控日志）";
  }
  return "未预期系统异常（详情仅限受控日志）";
}

function safeErrorLogRow(row: typeof errorLogs.$inferSelect): ErrorLogRow {
  return {
    id: row.id,
    errorId: row.errorId,
    path: row.path,
    method: row.method,
    userId: row.userId,
    message: operationalErrorSummary(row.message),
    createdAt: row.createdAt.toISOString(),
  };
}

function streamKey(connector: string, stream: string): string {
  return `${connector}\u0000${stream}`;
}

interface ConnectorHealthContext {
  rows: ConnectorRunHealthRow[];
  identityEvidenceByScope: Map<string, ConnectorIdentityEvidence>;
}

async function getConnectorRunHealth(db: AnyDb, now: Date): Promise<ConnectorHealthContext> {
  const [latestRuns, checkpoints, exceptionCounts, aliasCounts, identifierCounts] = await Promise.all([
    db
      .selectDistinctOn([integrationRuns.connector, integrationRuns.stream], {
        id: integrationRuns.id,
        connector: integrationRuns.connector,
        stream: integrationRuns.stream,
        status: integrationRuns.status,
        requestScope: integrationRuns.requestScope,
        sourceRows: integrationRuns.sourceRows,
        stagedRows: integrationRuns.stagedRows,
        rejectedRows: integrationRuns.rejectedRows,
        error: integrationRuns.error,
        startedAt: integrationRuns.startedAt,
        finishedAt: integrationRuns.finishedAt,
      })
      .from(integrationRuns)
      .orderBy(
        integrationRuns.connector,
        integrationRuns.stream,
        desc(integrationRuns.startedAt),
        desc(integrationRuns.id),
      ),
    db
      .select({
        connector: integrationCheckpoints.connector,
        stream: integrationCheckpoints.stream,
        version: integrationCheckpoints.version,
        lastRunId: integrationCheckpoints.lastRunId,
        lastSuccessAt: integrationCheckpoints.lastSuccessAt,
      })
      .from(integrationCheckpoints),
    db
      .select({
        scope: aliasExceptions.scope,
        status: aliasExceptions.status,
        count: sql<number>`count(*)::int`,
      })
      .from(aliasExceptions)
      .groupBy(aliasExceptions.scope, aliasExceptions.status),
    db
      .select({ scope: aliases.scope, count: sql<number>`count(*)::int` })
      .from(aliases)
      .groupBy(aliases.scope),
    db
      .select({ scope: skuIdentifiers.scope, count: sql<number>`count(*)::int` })
      .from(skuIdentifiers)
      .where(eq(skuIdentifiers.active, true))
      .groupBy(skuIdentifiers.scope),
  ]) as [
    {
      id: number;
      connector: string;
      stream: string;
      status: string;
      requestScope: unknown;
      sourceRows: number;
      stagedRows: number;
      rejectedRows: number;
      error: string | null;
      startedAt: Date;
      finishedAt: Date | null;
    }[],
    {
      connector: string;
      stream: string;
      version: number;
      lastRunId: number;
      lastSuccessAt: Date;
    }[],
    { scope: string; status: string; count: number }[],
    { scope: string; count: number }[],
    { scope: string; count: number }[],
  ];

  const checkpointsByStream = new Map(
    checkpoints.map((row) => [streamKey(row.connector, row.stream), row]),
  );
  const identityEvidenceByScope = new Map<string, ConnectorIdentityEvidence>();
  const evidenceFor = (scope: string): ConnectorIdentityEvidence => {
    const current = identityEvidenceByScope.get(scope);
    if (current) return current;
    const created = { openExceptions: 0, observedIdentities: 0 };
    identityEvidenceByScope.set(scope, created);
    return created;
  };
  for (const row of exceptionCounts) {
    const evidence = evidenceFor(row.scope);
    const count = Number(row.count);
    if (row.status === "open") evidence.openExceptions += count;
    // Open values prove the scope has been observed; ignored values are explicit reviewed outcomes.
    // Resolved rows count through the active alias/identifier they created, not historical status alone.
    if (row.status === "open" || row.status === "ignored") evidence.observedIdentities += count;
  }
  for (const row of [...aliasCounts, ...identifierCounts]) {
    evidenceFor(row.scope).observedIdentities += Number(row.count);
  }

  const rows = latestRuns.map((run) => {
    const scope = scopeObject(run.requestScope);
    const checkpoint = checkpointsByStream.get(streamKey(run.connector, run.stream));
    const aliasScope = ALIAS_SCOPE_BY_CONNECTOR[run.connector];
    const checkpointAgeHours = checkpoint
      ? Math.round(((now.getTime() - checkpoint.lastSuccessAt.getTime()) / 3_600_000) * 10) / 10
      : null;
    return {
      connector: run.connector,
      stream: run.stream,
      status: run.status as ConnectorRunHealthRow["status"],
      sourceRows: run.sourceRows,
      stagedRows: run.stagedRows,
      rejectedRows: run.rejectedRows,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      sourceAsOf: sourceDate(scope.sourceAsOf),
      schemaHashPrefix: schemaHashPrefix(scope.schemaHash),
      unresolvedAliases: nonNegativeInteger(scope.unresolvedAliases),
      openScopedAliasExceptions: aliasScope
        ? (identityEvidenceByScope.get(aliasScope)?.openExceptions ?? 0)
        : 0,
      checkpointVersion: checkpoint?.version ?? null,
      checkpointLastSuccessAt: checkpoint?.lastSuccessAt.toISOString() ?? null,
      checkpointAgeHours,
      checkpointOnLatestRun: checkpoint?.lastRunId === run.id,
      emptySource: scope.emptySource === true,
      releaseBlocked: scope.releaseBlocked === true,
      errorSummary: run.status === "failed" ? connectorErrorSummary(run.error) : null,
    };
  });
  return { rows, identityEvidenceByScope };
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
  const generatedAt = new Date();

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
      message: r.message === null
        ? null
        : r.ok
          ? "任务成功（详情仅限受控日志）"
          : operationalErrorSummary(r.message),
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
  const connectorHealth = await getConnectorRunHealth(db, generatedAt);
  const identityEvidence = Object.fromEntries(
    [...connectorHealth.identityEvidenceByScope.entries()]
      .filter(([scope]) => ["JST", "JIANDAOYUN", "YONYOU"].includes(scope)),
  ) as Partial<Record<ConnectorIdentityScope, ConnectorIdentityEvidence>>;

  return {
    generatedAt: generatedAt.toISOString(),
    dbOk,
    migrations: { files, applied, drift },
    lastJobRuns,
    recentErrors: errRows.map(safeErrorLogRow),
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
    connectors: getConnectorReadiness(process.env, generatedAt, identityEvidence),
    connectorRuns: connectorHealth.rows,
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
  return rows.map(safeErrorLogRow);
}
