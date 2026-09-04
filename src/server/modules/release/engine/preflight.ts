/**
 * E3-13 导入智能预检。
 *
 * 对同模板、同 scope 的当前任务与最近一次已实际放行（存在 committed staging 行）的任务做：
 * - 输入行指纹 diff（新增 / 删除 / 未变）；
 * - targetTable + kind 分桶的行数与数量控制总量比较；
 * - 任一有足够样本的控制量绝对偏差 >30% 时，执行放行前要求显式说明并审计覆盖。
 *
 * 预检只比较原始 staging 载荷；人工认领产生的 `_resolved` 不参与指纹，避免把治理动作误报成源文件变化。
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dDeviationPct, dNeg, dQty, dZero } from "@/server/core/decimal";
import { writeAudit } from "@/server/core/audit";
import { ApiError } from "@/server/modules/master/common";
import type { AnyDb, ReleaseUser } from "./common";

const PREFLIGHT_VERSION = "import-preflight-v1";
const THRESHOLD_PCT = "30.00";
const MIN_BASELINE_ROWS = 10;

/** 这些字段是数量控制量；金额/单价不在此相加，避免跨 SKU 的无意义合计。 */
const QUANTITY_FIELDS: Record<string, readonly string[]> = {
  inventory: ["qty"],
  expiry: ["qty"],
  sales: ["qty"],
  transit: ["qty"],
  demand: ["qty"],
  pallet: ["qty"],
  stock_summary: ["qty", "inboundQty"],
};

type PreflightStatus = "pass" | "blocked" | "baseline_missing" | "not_applicable";

interface JobRow {
  id: number;
  template: string;
  filename: string;
  scope: unknown;
  controlRows: number | null;
}

interface InputRow {
  targetTable: string | null;
  payload: unknown;
  status: string;
}

interface BucketProfile {
  bucket: string;
  rows: number;
  quantities: Record<string, string>;
}

interface InputProfile {
  rows: number;
  digest: string;
  fingerprints: Map<string, number>;
  buckets: BucketProfile[];
}

export interface ImportPreflightReason {
  bucket: string;
  metric: "rows" | `qty:${string}`;
  baseline: string;
  current: string;
  driftPct: string;
}

export interface ImportPreflightResult {
  version: typeof PREFLIGHT_VERSION;
  jobId: number;
  template: string;
  filename: string;
  baselineJobId: number | null;
  baselineFilename: string | null;
  status: PreflightStatus;
  thresholdPct: string;
  minimumBaselineRows: number;
  currentRows: number;
  baselineRows: number | null;
  addedRows: number | null;
  removedRows: number | null;
  unchangedRows: number | null;
  currentDigest: string;
  baselineDigest: string | null;
  reasons: ImportPreflightReason[];
  token: string;
  note: string;
}

export interface PreflightOverride {
  token: string;
  reason: string;
}

export type PreflightOverrides = Record<string, PreflightOverride>;

function canonical(value: unknown): string {
  if (value === undefined) return JSON.stringify("__undefined__");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((key) => key !== "_resolved")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(",")}}`;
}

function scopeKey(scope: unknown): string {
  return canonical(scope ?? null);
}

function absDecimal(value: string): string {
  return dCmp(value, "0") < 0 ? dNeg(value, 4) : dQty(value);
}

function numericValue(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const raw = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  return raw;
}

function bucketName(row: InputRow): string {
  const target = row.targetTable ?? "(unknown)";
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown>
    : null;
  const kind = typeof payload?.kind === "string" && payload.kind.trim() ? payload.kind.trim() : null;
  return kind ? `${target}:${kind}` : target;
}

function profileRows(template: string, rows: InputRow[]): InputProfile {
  const fingerprints = new Map<string, number>();
  const buckets = new Map<string, { rows: number; quantities: Record<string, string> }>();
  const qtyFields = QUANTITY_FIELDS[template] ?? [];

  for (const row of rows) {
    const input = `${row.targetTable ?? "(unknown)"}\0${canonical(row.payload)}`;
    const fingerprint = createHash("sha256").update(input).digest("hex");
    fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);

    const bucket = bucketName(row);
    const agg = buckets.get(bucket) ?? { rows: 0, quantities: {} };
    agg.rows++;
    const payload = row.payload && typeof row.payload === "object"
      ? row.payload as Record<string, unknown>
      : null;
    for (const field of qtyFields) {
      const value = numericValue(payload?.[field]);
      if (value == null) continue;
      const magnitude = absDecimal(value);
      agg.quantities[field] = dAdd(agg.quantities[field] ?? "0.0000", magnitude, 4);
    }
    buckets.set(bucket, agg);
  }

  const digest = createHash("sha256")
    .update(
      [...fingerprints.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([hash, count]) => `${hash}:${count}`)
        .join("|"),
    )
    .digest("hex");

  return {
    rows: rows.length,
    digest,
    fingerprints,
    buckets: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, value]) => ({ bucket, ...value })),
  };
}

function diffFingerprints(current: Map<string, number>, baseline: Map<string, number>) {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  const keys = new Set([...current.keys(), ...baseline.keys()]);
  for (const key of keys) {
    const c = current.get(key) ?? 0;
    const b = baseline.get(key) ?? 0;
    unchanged += Math.min(c, b);
    if (c > b) added += c - b;
    if (b > c) removed += b - c;
  }
  return { added, removed, unchanged };
}

function absoluteDeviationPct(baseline: string, current: string): string {
  if (dZero(baseline)) return dZero(current) ? "0.00" : "100.00";
  const pct = dDeviationPct(baseline, current);
  return dCmp(pct, "0") < 0 ? dNeg(pct, 2) : pct;
}

function compareProfiles(current: InputProfile, baseline: InputProfile): ImportPreflightReason[] {
  const reasons: ImportPreflightReason[] = [];
  const currentBuckets = new Map(current.buckets.map((bucket) => [bucket.bucket, bucket]));
  const baselineBuckets = new Map(baseline.buckets.map((bucket) => [bucket.bucket, bucket]));
  const names = new Set([...currentBuckets.keys(), ...baselineBuckets.keys()]);

  for (const bucket of [...names].sort()) {
    const c = currentBuckets.get(bucket) ?? { bucket, rows: 0, quantities: {} };
    const b = baselineBuckets.get(bucket) ?? { bucket, rows: 0, quantities: {} };
    const rowPct = absoluteDeviationPct(String(b.rows), String(c.rows));
    if (b.rows >= MIN_BASELINE_ROWS && dCmp(rowPct, THRESHOLD_PCT) > 0) {
      reasons.push({
        bucket,
        metric: "rows",
        baseline: String(b.rows),
        current: String(c.rows),
        driftPct: rowPct,
      });
    }

    const fields = new Set([...Object.keys(c.quantities), ...Object.keys(b.quantities)]);
    for (const field of [...fields].sort()) {
      const baselineQty = b.quantities[field] ?? "0.0000";
      const currentQty = c.quantities[field] ?? "0.0000";
      const qtyPct = absoluteDeviationPct(baselineQty, currentQty);
      if (b.rows >= MIN_BASELINE_ROWS && dCmp(qtyPct, THRESHOLD_PCT) > 0) {
        reasons.push({
          bucket,
          metric: `qty:${field}`,
          baseline: baselineQty,
          current: currentQty,
          driftPct: qtyPct,
        });
      }
    }
  }
  return reasons;
}

async function loadInputRows(db: AnyDb, jobId: number): Promise<InputRow[]> {
  return db
    .select({
      targetTable: schema.stagingRows.targetTable,
      payload: schema.stagingRows.payload,
      status: schema.stagingRows.status,
    })
    .from(schema.stagingRows)
    .where(
      and(
        eq(schema.stagingRows.importJobId, jobId),
        inArray(schema.stagingRows.status, ["pending", "validated", "error", "committed"]),
      ),
    );
}

async function findBaselineJob(db: AnyDb, current: JobRow): Promise<JobRow | null> {
  const candidates: JobRow[] = await db
    .select({
      id: schema.importJobs.id,
      template: schema.importJobs.template,
      filename: schema.importJobs.filename,
      scope: schema.importJobs.scope,
      controlRows: schema.importJobs.controlRows,
    })
    .from(schema.importJobs)
    .where(
      and(
        eq(schema.importJobs.template, current.template),
        lt(schema.importJobs.id, current.id),
        eq(schema.importJobs.status, "done"),
      ),
    )
    .orderBy(desc(schema.importJobs.id))
    .limit(50);

  const expectedScope = scopeKey(current.scope);
  for (const candidate of candidates) {
    if (scopeKey(candidate.scope) !== expectedScope) continue;
    const [accepted]: { id: number }[] = await db
      .select({ id: schema.stagingRows.id })
      .from(schema.stagingRows)
      .where(
        and(
          eq(schema.stagingRows.importJobId, candidate.id),
          eq(schema.stagingRows.status, "committed"),
        ),
      )
      .limit(1);
    if (accepted) return candidate;
  }
  return null;
}

export async function getImportPreflight(
  db: AnyDb,
  jobId: number,
): Promise<ImportPreflightResult> {
  const [current]: JobRow[] = await db
    .select({
      id: schema.importJobs.id,
      template: schema.importJobs.template,
      filename: schema.importJobs.filename,
      scope: schema.importJobs.scope,
      controlRows: schema.importJobs.controlRows,
    })
    .from(schema.importJobs)
    .where(eq(schema.importJobs.id, jobId));
  if (!current) throw new ApiError(404, `导入任务不存在：#${jobId}`);

  const currentRows = await loadInputRows(db, current.id);
  const currentProfile = profileRows(current.template, currentRows);
  if (currentRows.length === 0) {
    const token = createHash("sha256")
      .update(`${PREFLIGHT_VERSION}|${current.id}|empty`)
      .digest("hex");
    return {
      version: PREFLIGHT_VERSION,
      jobId: current.id,
      template: current.template,
      filename: current.filename,
      baselineJobId: null,
      baselineFilename: null,
      status: "not_applicable",
      thresholdPct: THRESHOLD_PCT,
      minimumBaselineRows: MIN_BASELINE_ROWS,
      currentRows: 0,
      baselineRows: null,
      addedRows: null,
      removedRows: null,
      unchangedRows: null,
      currentDigest: currentProfile.digest,
      baselineDigest: null,
      reasons: [],
      token,
      note: "该任务没有 staging 输入行，无法执行版本预检。",
    };
  }

  const baseline = await findBaselineJob(db, current);
  if (!baseline) {
    const token = createHash("sha256")
      .update(`${PREFLIGHT_VERSION}|${current.id}|${currentProfile.digest}|no-baseline`)
      .digest("hex");
    return {
      version: PREFLIGHT_VERSION,
      jobId: current.id,
      template: current.template,
      filename: current.filename,
      baselineJobId: null,
      baselineFilename: null,
      status: "baseline_missing",
      thresholdPct: THRESHOLD_PCT,
      minimumBaselineRows: MIN_BASELINE_ROWS,
      currentRows: currentProfile.rows,
      baselineRows: null,
      addedRows: null,
      removedRows: null,
      unchangedRows: null,
      currentDigest: currentProfile.digest,
      baselineDigest: null,
      reasons: [],
      token,
      note: "同模板、同范围尚无已放行基线；本次将建立首个可比版本。",
    };
  }

  const baselineRows = await loadInputRows(db, baseline.id);
  const baselineProfile = profileRows(baseline.template, baselineRows);
  const diff = diffFingerprints(currentProfile.fingerprints, baselineProfile.fingerprints);
  const reasons = compareProfiles(currentProfile, baselineProfile);
  const token = createHash("sha256")
    .update(
      canonical({
        version: PREFLIGHT_VERSION,
        jobId: current.id,
        baselineJobId: baseline.id,
        currentDigest: currentProfile.digest,
        baselineDigest: baselineProfile.digest,
        reasons,
      }),
    )
    .digest("hex");

  return {
    version: PREFLIGHT_VERSION,
    jobId: current.id,
    template: current.template,
    filename: current.filename,
    baselineJobId: baseline.id,
    baselineFilename: baseline.filename,
    status: reasons.length > 0 ? "blocked" : "pass",
    thresholdPct: THRESHOLD_PCT,
    minimumBaselineRows: MIN_BASELINE_ROWS,
    currentRows: currentProfile.rows,
    baselineRows: baselineProfile.rows,
    addedRows: diff.added,
    removedRows: diff.removed,
    unchangedRows: diff.unchanged,
    currentDigest: currentProfile.digest,
    baselineDigest: baselineProfile.digest,
    reasons,
    token,
    note: reasons.length > 0
      ? "控制量较最近已放行版本偏差超过 30%；核对文件范围与数据日期后，填写原因方可继续。"
      : "输入规模与最近已放行版本处于允许范围。",
  };
}

export async function assertImportPreflight(
  db: AnyDb,
  user: ReleaseUser,
  args: {
    jobIds?: number[];
    dryRun: boolean;
    preflightOverrides?: PreflightOverrides;
  },
): Promise<void> {
  if (args.dryRun || !args.jobIds?.length) return;
  for (const jobId of args.jobIds) {
    const result = await getImportPreflight(db, jobId);
    if (result.status !== "blocked") continue;
    const override = args.preflightOverrides?.[String(jobId)];
    if (!override || override.token !== result.token || override.reason.trim().length < 5) {
      const error = new ApiError(
        409,
        `导入任务 #${jobId} 与最近已放行版本的控制量偏差超过 ${THRESHOLD_PCT}%；请核对后填写至少 5 个字的放行说明。`,
      );
      error.code = "IMPORT_PREFLIGHT_BLOCKED";
      throw error;
    }
    await writeAudit(db, {
      userId: user.id,
      entity: "import_job",
      entityId: jobId,
      action: "preflight_override",
      before: {
        baselineJobId: result.baselineJobId,
        baselineRows: result.baselineRows,
        baselineDigest: result.baselineDigest,
      },
      after: {
        currentRows: result.currentRows,
        currentDigest: result.currentDigest,
        reasons: result.reasons,
        token: result.token,
        reason: override.reason.trim().slice(0, 500),
      },
    });
  }
}
