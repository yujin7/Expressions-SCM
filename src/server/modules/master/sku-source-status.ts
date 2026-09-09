import { createHash } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dayDiff, todayShanghai } from "@/server/core/business-day";
import { loadUserScopes } from "@/server/core/data-scope";
import type { SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";
import { ApiError } from "./common";
import { assertPlatformIdentityScope } from "./platform-identity-access";

const SOURCES = [
  { key: "jst", label: "聚水潭直连", stream: "item-master", scope: "JST", table: "jst_item_master_observation", mode: "changes" },
  { key: "jdy", label: "简道云聚水潭镜像", stream: "jst-item-master-mirror-observation", scope: "JIANDAOYUN", table: "jdy_jst_item_master_mirror_observation", mode: "snapshot" },
] as const;
type Source = typeof SOURCES[number];
const ACTION = "confirm_source_status";
const ROW_LIMIT = 100;
const rawObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rowsOf = <T>(result: unknown): T[] => Array.isArray(result) ? result as T[] : ((result as { rows?: T[] })?.rows ?? []);
const iso = (value: Date | string | null): string | null => value == null ? null : new Date(value).toISOString();
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fullWidth = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0xff01 + i)).join("") + "\u3000";
const halfWidth = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).join("") + " ";

export interface SourceStatusRow {
  id: number; runId: number; jobId: number; rowNo: number; externalCode: string;
  rawStatus: string | null; meaning: string | null; sourceAsOf: string | null; ageDays: number | null;
  sourceRecordId: string | null; modifiedAt: string | null; reasons: string[]; confirmable: boolean;
}
interface Attempt { id: number; status: string; startedAt: string | null; finishedAt: string | null }
export interface SkuStatusSource {
  key: Source["key"]; label: string; mode: Source["mode"]; latestAttempt: Attempt | null;
  latestSuccess: (Attempt & { jobId: number | null; jobStatus: string | null; sourceAsOf: string | null }) | null;
  rows: SourceStatusRow[]; total: number; truncated: boolean;
}
interface InternalStatus { id: number; code: string; name: string; lifecycle: string; active: boolean; commercialRole: string; updatedAt: string | null }
export interface SourceStatusHistory {
  id: number; at: string; actor: string; from: string; to: string; reason: string;
  source: string; externalCode: string; rawStatus: string | null; sourceAsOf: string | null; runId: number; jobId: number;
}
export interface SkuSourceStatus {
  sku: InternalStatus; observedOn: string; sources: SkuStatusSource[]; fingerprint: string; canWrite: boolean;
  history: SourceStatusHistory[]; historyHasMore: boolean;
}

/** Governance is global master-data work. Re-read roles, activation and scopes for every call. */
async function authorize(db: AnyDb, actor: SessionUser, writing = false): Promise<boolean> {
  const [user] = await db.select({ id: schema.users.id, name: schema.users.name, roles: schema.users.roles, active: schema.users.active })
    .from(schema.users).where(eq(schema.users.id, actor.id));
  if (!user?.active) throw new ApiError(401, "账号已停用或不存在");
  const roles: string[] = user.roles;
  if (!roles.some(role => ["admin", "pmc", "purchasing", "warehouse"].includes(role))) throw new ApiError(403, "无权限查看商品来源状态");
  assertPlatformIdentityScope({ ...user, ...await loadUserScopes(db, actor.id), isApprover: false });
  const canWrite = roles.some(role => ["admin", "pmc"].includes(role));
  if (writing && !canWrite) throw new ApiError(403, "确认商品生命周期需要计划或管理员权限");
  return canWrite;
}

async function internalStatus(db: AnyDb, id: number): Promise<InternalStatus> {
  const [row] = await db.select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name,
    lifecycle: schema.skus.lifecycle, active: schema.skus.active, commercialRole: schema.skus.commercialRole, updatedAt: schema.skus.updatedAt })
    .from(schema.skus).where(eq(schema.skus.id, id));
  if (!row) throw new ApiError(404, "SKU 不存在");
  return { ...row, updatedAt: iso(row.updatedAt) };
}

function statusMeaning(source: Source, raw: unknown): string | null {
  // Mirror Chinese values have a different contract. Unknown values stay unknown.
  if (source.key === "jdy") return raw === "启用" ? "启用（镜像原文）" : null;
  if (raw === 0 || raw === "0") return "备用";
  if (raw === 1 || raw === "1") return "启用";
  if (raw === -1 || raw === "-1") return "禁用";
  return null;
}

async function sourceStatus(db: AnyDb, sku: InternalStatus, source: Source, today: string): Promise<SkuStatusSource> {
  const runQuery = (successOnly: boolean) => db.select({ id: schema.integrationRuns.id, status: schema.integrationRuns.status,
    startedAt: schema.integrationRuns.startedAt, finishedAt: schema.integrationRuns.finishedAt,
    jobId: schema.integrationRuns.importJobId, jobStatus: schema.importJobs.status, sourceAsOf: schema.importJobs.sourceAsOf,
    requestScope: schema.integrationRuns.requestScope })
    .from(schema.integrationRuns).leftJoin(schema.importJobs, eq(schema.importJobs.id, schema.integrationRuns.importJobId))
    .where(and(eq(schema.integrationRuns.connector, source.key), eq(schema.integrationRuns.stream, source.stream),
      successOnly ? eq(schema.integrationRuns.status, "succeeded") : undefined))
    .orderBy(desc(schema.integrationRuns.startedAt), desc(schema.integrationRuns.id)).limit(1);
  // Confirmation runs on one transaction connection; do not enqueue concurrent pg queries.
  const [latest] = await runQuery(false);
  const [success] = await runQuery(true);
  const attempt = (run: typeof latest): Attempt => ({ id: run.id, status: run.status, startedAt: iso(run.startedAt), finishedAt: iso(run.finishedAt) });
  // Current scoped ownership is separate from the immutable mapping recorded during import.
  // Internal code is a discovery clue only: it is never inserted into the owners CTE.
  const code = source.key === "jdy" ? sql`sr.payload->'data'->>'skuCode'` : sql`sr.payload->>'skuCode'`;
  const normalizedCode = sql`trim(regexp_replace(translate(coalesce(${code}, ''), ${fullWidth}, ${halfWidth}), '[[:space:]]+', ' ', 'g'))`;
  const recordedId = source.key === "jdy" ? sql`sr.payload->'_identity'->>'skuId'` : sql`sr.payload->'_resolved'->>'skuId'`;
  const result = await db.execute(sql`
    WITH owners AS (
      SELECT raw_value AS code, target_id AS sku_id FROM aliases WHERE alias_type = 'sku_code' AND scope = ${source.scope}
      UNION
      SELECT value AS code, sku_id FROM sku_identifiers WHERE kind = 'external' AND scope = ${source.scope} AND active
    ), candidates AS (
      SELECT sr.id, sr.row_no, sr.status AS row_status, sr.payload, ir.id AS run_id, ij.id AS job_id,
        ij.status AS job_status, ij.source_as_of, ir.request_scope, ir.source_rows, ir.staged_rows, ir.rejected_rows,
        ${normalizedCode} AS code, ${recordedId} AS recorded_id,
        dense_rank() OVER (PARTITION BY ${normalizedCode} ORDER BY ij.source_as_of DESC NULLS LAST, ir.started_at DESC, ir.id DESC) AS version_rank
      FROM staging_rows sr JOIN import_jobs ij ON ij.id = sr.import_job_id
      JOIN integration_runs ir ON ir.import_job_id = ij.id
      WHERE ir.connector = ${source.key} AND ir.stream = ${source.stream} AND ir.status = 'succeeded'
        AND sr.target_table = ${source.table}
        AND ij.status <> 'superseded'
        AND (${source.mode} <> 'snapshot' OR ir.id = ${success?.id ?? -1})
        AND (${normalizedCode} IN (SELECT code FROM owners WHERE sku_id = ${sku.id})
          OR ${normalizedCode} = ${sku.code} OR ${recordedId} = ${String(sku.id)})
    ), current_rows AS (
      SELECT *, count(*) OVER (PARTITION BY code) AS duplicate_count FROM candidates WHERE version_rank = 1
    )
    SELECT cr.*, count(*) OVER () AS total,
      (SELECT count(DISTINCT sku_id) FROM owners o WHERE o.code = cr.code) AS owner_count,
      (SELECT min(sku_id) FROM owners o WHERE o.code = cr.code) AS owner_id
    FROM current_rows cr ORDER BY cr.code, cr.id LIMIT ${ROW_LIMIT}
  `);
  const rawRows = rowsOf<Record<string, unknown>>(result);
  const rows = rawRows.map(row => {
    const payload = rawObject(row.payload);
    const data = source.key === "jdy" ? rawObject(payload.data) : payload;
    const raw = data[source.key === "jdy" ? "itemStatus" : "enabled"];
    const rawStatus = typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
    const meaning = statusMeaning(source, raw);
    const sourceAsOf = typeof row.source_as_of === "string" ? row.source_as_of : null;
    const ageDays = sourceAsOf ? dayDiff(sourceAsOf, today) : null;
    const reasons: string[] = [];
    if (latest?.status !== "succeeded") reasons.push(latest?.status === "running" ? "最新同步进行中，完成后重核" : "最新同步失败，历史成功不能代表当前状态");
    if (success?.jobStatus !== "done" || rawObject(success?.requestScope).qualityBlocked === true) reasons.push("最近成功尝试的批次已失格或仍待复核");
    if (row.job_status !== "done") reasons.push("来源批次尚未通过完整性检查");
    if (rawObject(row.request_scope).qualityBlocked === true) reasons.push("来源控制量复核未通过");
    if (Number(row.source_rows) <= 0 || Number(row.source_rows) !== Number(row.staged_rows) || Number(row.rejected_rows) !== 0) reasons.push("来源与暂存控制量缺失、不一致或有拒收行");
    if (!["pending", "validated", "committed"].includes(String(row.row_status))) reasons.push("来源行被拒收");
    if (Number(row.duplicate_count) > 1) reasons.push("同批商品码重复，先回源裁决");
    if (Number(row.owner_count) !== 1 || Number(row.owner_id) !== sku.id) reasons.push("当前作用域身份未确认或存在冲突；同码不是归属证明");
    if (row.recorded_id && String(row.recorded_id) !== String(sku.id)) reasons.push("导入时归属与当前归属冲突");
    if (payload.sourceDeletedAt != null && payload.sourceDeletedAt !== "") reasons.push("来源记录带删除标记");
    if (meaning == null) reasons.push("来源状态缺失或枚举未核实");
    if (ageDays == null || !Number.isFinite(ageDays) || ageDays < 0) reasons.push("业务截止日期缺失或异常");
    return { id: Number(row.id), runId: Number(row.run_id), jobId: Number(row.job_id), rowNo: Number(row.row_no), externalCode: String(row.code),
      rawStatus, meaning, sourceAsOf, ageDays, reasons, confirmable: reasons.length === 0,
      sourceRecordId: typeof payload.sourceRecordId === "string" ? payload.sourceRecordId : null,
      modifiedAt: typeof data.modifiedAt === "string" ? data.modifiedAt : null };
  });
  const total = Number(rawRows[0]?.total ?? 0);
  if (total > ROW_LIMIT) for (const row of rows) { row.confirmable = false; row.reasons.push("关联记录超出展示上限，先核对身份范围"); }
  return { key: source.key, label: source.label, mode: source.mode, latestAttempt: latest ? attempt(latest) : null,
    latestSuccess: success ? { ...attempt(success), jobId: success.jobId, jobStatus: success.jobStatus, sourceAsOf: success.sourceAsOf } : null,
    rows, total, truncated: total > ROW_LIMIT };
}

async function evidence(db: AnyDb, id: number) {
  const sku = await internalStatus(db, id);
  const observedOn = todayShanghai();
  const sources: SkuStatusSource[] = [];
  for (const source of SOURCES) sources.push(await sourceStatus(db, sku, source, observedOn));
  return { sku, observedOn, sources, fingerprint: fingerprint({ sku, observedOn, sources }) };
}

export async function getSkuSourceStatus(id: number, actor: SessionUser, dbArg?: AnyDb, historyBefore?: number): Promise<SkuSourceStatus> {
  if (historyBefore !== undefined && (!Number.isSafeInteger(historyBefore) || historyBefore <= 0)) throw new ApiError(400, "无效的历史游标");
  const db = dbArg ?? await getDbAsync();
  const canWrite = await authorize(db, actor);
  const current = await evidence(db, id);
  const audits = await db.select({ id: schema.auditLogs.id, at: schema.auditLogs.createdAt, actor: schema.users.name,
    before: schema.auditLogs.before, after: schema.auditLogs.after })
    .from(schema.auditLogs).leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
    .where(and(eq(schema.auditLogs.entity, "sku"), eq(schema.auditLogs.entityId, id), eq(schema.auditLogs.action, ACTION),
      historyBefore === undefined ? undefined : lt(schema.auditLogs.id, historyBefore)))
    .orderBy(desc(schema.auditLogs.id)).limit(21);
  const history: SourceStatusHistory[] = audits.slice(0, 20).map((audit: { id: number; at: Date; actor: string | null; before: unknown; after: unknown }) => {
    const after = rawObject(audit.after), confirmation = rawObject(after.confirmation), row = rawObject(confirmation.row);
    return { id: audit.id, at: iso(audit.at)!, actor: audit.actor ?? "历史用户", from: String(rawObject(audit.before).lifecycle), to: String(after.lifecycle),
      reason: String(confirmation.reason), source: String(confirmation.source), externalCode: String(row.externalCode),
      rawStatus: typeof row.rawStatus === "string" ? row.rawStatus : null, sourceAsOf: typeof row.sourceAsOf === "string" ? row.sourceAsOf : null,
      runId: Number(row.runId), jobId: Number(row.jobId) };
  });
  return { ...current, canWrite, history, historyHasMore: audits.length > 20 };
}

const confirmationSchema = z.object({
  requestId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), source: z.enum(["jst", "jdy"]), rowId: z.number().int().positive(),
  lifecycle: z.enum(["on_sale", "trial", "halted", "retired"]), reason: z.string().trim().min(6, "请写明业务核实依据（至少6字）").max(500),
  independentlyVerified: z.literal(true),
}).strict();

/** Human decision, not an enum mapper. SKU row lock serializes confirmation + audit replay. */
export async function confirmSkuSourceStatus(id: number, input: unknown, actor: SessionUser, dbArg?: AnyDb) {
  const v = confirmationSchema.parse(input);
  const db = dbArg ?? await getDbAsync();
  return db.transaction(async (tx: AnyDb) => {
    await authorize(tx, actor, true);
    const [locked] = await tx.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.id, id)).for("update");
    if (!locked) throw new ApiError(404, "SKU 不存在");
    const prior = await tx.select({ id: schema.auditLogs.id, userId: schema.auditLogs.userId, after: schema.auditLogs.after }).from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entity, "sku"), eq(schema.auditLogs.entityId, id), eq(schema.auditLogs.action, ACTION),
        sql`${schema.auditLogs.after}->'confirmation'->>'requestId' = ${v.requestId}`)).limit(1);
    if (prior[0]) {
      if (prior[0].userId !== actor.id || rawObject(rawObject(prior[0].after).confirmation).inputHash !== fingerprint(v)) throw new ApiError(409, "同一请求标识已用于不同确认，请重新核对");
      return { auditId: prior[0].id, lifecycle: String(rawObject(prior[0].after).lifecycle), replayed: true };
    }
    const current = await evidence(tx, id);
    if (current.fingerprint !== v.fingerprint) throw new ApiError(409, "来源或主档已变化，请刷新后重新核对；原输入未保存");
    const source = current.sources.find(source => source.key === v.source)!;
    const row = source.rows.find(row => row.id === v.rowId);
    if (!row?.confirmable) throw new ApiError(409, "该来源当前不具备确认资格，请先处理来源或身份问题");
    const updatedAt = new Date();
    await tx.update(schema.skus).set({ lifecycle: v.lifecycle, updatedAt }).where(eq(schema.skus.id, id));
    await writeAudit(tx, { userId: actor.id, entity: "sku", entityId: id, action: ACTION,
      before: current.sku, after: { ...current.sku, lifecycle: v.lifecycle, updatedAt: iso(updatedAt), confirmation: { requestId: v.requestId, inputHash: fingerprint(v),
        source: source.label, row, latestAttempt: source.latestAttempt, observedOn: current.observedOn, fingerprint: current.fingerprint,
        reason: v.reason, independentlyVerified: true } } });
    const [saved] = await tx.select({ id: schema.auditLogs.id }).from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "sku"), eq(schema.auditLogs.entityId, id),
      eq(schema.auditLogs.action, ACTION), sql`${schema.auditLogs.after}->'confirmation'->>'requestId' = ${v.requestId}`));
    return { auditId: saved.id as number, lifecycle: v.lifecycle, replayed: false };
  });
}
