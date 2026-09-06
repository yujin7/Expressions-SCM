/**
 * 用友只读观测同步：按已批准契约拉数 → 原样落 staging → 留证据 → 记 run/checkpoint。
 *
 * **刻意不做字段映射**。截至落地时该 AppKey 的 8 条契约在控制台全部未授权（310037），
 * 我从未见过任何一条的真实响应结构。凭想象写解析器＝把猜测伪装成实现，
 * 本仓明确禁止（"禁止用占位实现伪装完成"）。因此本模块只做三件确定无疑的事：
 *   1. 按契约名（双重白名单）取数；
 *   2. 把响应**原样**落进 staging，附契约名与结构指纹；
 *   3. 写不可变证据 + run/checkpoint，便于重放与追责。
 * 字段语义留到看见真实数据后再定，那时映射是有据可依的一次小改动。
 *
 * 与 D16 同一口径：用友数据是**观测/对账参照**，永远不直接进库存台账或总账。
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { integrationCheckpoints, integrationRuns, users } from "@/db/schema";
import { isYonyouAuthorizationWait } from "@/lib/yonyou-job-summary";
import {
  createSourceImportJobInTransaction,
  finalizeImportJob,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "@/server/import/staging";
import { writeIntegrationEvidence } from "./evidence";
import { YonyouApiError, YonyouClient } from "./yonyou-client";
import {
  yonyouContractStreamKey,
  yonyouReadContractByName,
  type YonyouReadContractName,
} from "./yonyou-contracts";

const CONNECTOR = "yy";
const SCHEMA_VERSION = "yonyou-observation-v1";
/** staging 目标表名：观测层，非业务表。放行阶段才会有人决定它变成什么。 */
const TARGET_TABLE = "yonyou_observation";
const RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1_000;
const SHAPE_ARRAY_SAMPLE_LIMIT = 100;
const FIELD_PROFILE_RECORD_LIMIT = 100;
const FIELD_PROFILE_NESTED_ARRAY_LIMIT = 20;
const FIELD_PROFILE_FIELD_LIMIT = 256;
const FIELD_PROFILE_DEPTH_LIMIT = 6;

export type YonyouSensitiveFieldCategory =
  | "contact"
  | "credential"
  | "financial"
  | "identity"
  | "location";

export interface YonyouFieldProfileEntry {
  /** Sanitized key path only; source values are never copied into the profile. */
  path: string;
  types: string[];
  presentInRecords: number;
  optional: boolean;
  nullable: boolean;
  sensitiveCategory: YonyouSensitiveFieldCategory | null;
}

export interface YonyouFieldProfile {
  version: "yonyou-field-profile/v1";
  totalRecords: number;
  sampledRecords: number;
  fieldCount: number;
  sensitiveFieldCount: number;
  sensitiveCategories: YonyouSensitiveFieldCategory[];
  truncated: boolean;
  fields: YonyouFieldProfileEntry[];
}

export type YonyouFieldProfileSummary = Omit<YonyouFieldProfile, "fields">;

export interface YonyouSyncSummary {
  runId: number;
  importJobId: number | null;
  contract: string;
  /** 可识别数组的记录数；未知结构整包保留为一条观察，不推断其业务记录总量。 */
  sourceRows: number;
  stagedRows: number;
  evidenceHash: string;
  /** 观测到的响应结构指纹，供后续写映射时比对是否稳定。 */
  shapeFingerprint: string;
  /** 字段画像的聚合统计；完整无值路径只留在受控 evidence/run/job scope。 */
  fieldProfileSummary: YonyouFieldProfileSummary | null;
  /** 当前结构是否偏离同契约版本最后一个已接受基线。 */
  schemaDrift: boolean;
  /** 漂移时为 true；原始证据仍留存，但通用放行引擎会硬拒绝。 */
  releaseBlocked: boolean;
  replayed: boolean;
  /** 未授权时不算失败，如实记录并返回，便于运维看到"还差控制台授权"。 */
  blockedByConsoleGrant: boolean;
}

interface PriorRun {
  id: number;
  status: string;
  startedAt: Date;
  importJobId: number | null;
  sourceRows: number;
  stagedRows: number;
  rejectedRows: number;
  evidenceHash: string | null;
  evidencePath: string | null;
  error: string | null;
  requestScope: unknown;
}

function streamOf(contract: YonyouReadContractName): string {
  const meta = yonyouReadContractByName(contract);
  if (!meta) throw new Error(`未知的用友契约：${contract}`);
  // stream 用契约路径派生，避免中文名进 checkpoint 键
  return yonyouContractStreamKey(meta.path);
}

/**
 * 结构指纹：只取"键的形状"，不取值。用来判断两次响应结构是否一致——
 * 将来写字段映射时，先确认指纹稳定再动手，避免照着一次偶发响应写死。
 */
export function yonyouShapeFingerprint(value: unknown, depth = 0): string {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const shapes = new Set(
      sampleArray(value, SHAPE_ARRAY_SAMPLE_LIMIT)
        .map((item) => yonyouShapeFingerprint(item, depth + 1)),
    );
    return `[${[...shapes].sort().join("|")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${yonyouShapeFingerprint((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  return typeof value;
}

function sampleArray<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  if (limit <= 1) return [values[0]];
  const indexes = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    indexes.add(Math.round((index * (values.length - 1)) / (limit - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((index) => values[index]);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function safePathSegment(key: string): string {
  const normalized = key.trim().replace(/[\u0000-\u001f\u007f.[\]\\]/g, "_");
  if (!normalized) return "<empty-key>";
  if (
    /^\d{6,}$/.test(normalized)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(normalized)
    || (/^[A-Za-z0-9_-]{32,}$/.test(normalized) && /\d/.test(normalized))
  ) return "<dynamic-key>";
  return normalized.slice(0, 80);
}

function sensitiveCategory(key: string): YonyouSensitiveFieldCategory | null {
  const normalized = key.toLowerCase().replace(/[\s_.-]/g, "");
  if (/token|secret|password|passwd|pwd|accesskey|appkey|密钥|密码|令牌/.test(normalized)) {
    return "credential";
  }
  if (/idcard|identityno|citizenno|身份证|证件号|统一社会信用代码/.test(normalized)) {
    return "identity";
  }
  if (/bank|iban|accountno|bankaccount|taxno|开户|银行|账号|税号|银行卡/.test(normalized)) {
    return "financial";
  }
  if (/phone|mobile|telephone|email|contact|手机|电话|邮箱|联系人/.test(normalized)) {
    return "contact";
  }
  if (/address|postcode|zipcode|地址|住址|邮编/.test(normalized)) {
    return "location";
  }
  return null;
}

interface MutableFieldProfile {
  path: string;
  types: Set<string>;
  records: Set<number>;
  sensitiveCategory: YonyouSensitiveFieldCategory | null;
}

/**
 * Build a bounded mapping aid from observed records. The result contains schema metadata only:
 * no values, request parameters, source identifiers or credentials are copied into it.
 */
export function profileYonyouFields(records: readonly unknown[]): YonyouFieldProfile {
  const sampled = sampleArray(records, FIELD_PROFILE_RECORD_LIMIT);
  const fields = new Map<string, MutableFieldProfile>();
  let truncated = records.length > sampled.length;

  const recordField = (
    path: string,
    type: string,
    recordIndex: number,
    category: YonyouSensitiveFieldCategory | null,
  ) => {
    const existing = fields.get(path);
    if (existing) {
      existing.types.add(type);
      existing.records.add(recordIndex);
      if (!existing.sensitiveCategory && category) existing.sensitiveCategory = category;
      return;
    }
    if (fields.size >= FIELD_PROFILE_FIELD_LIMIT) {
      truncated = true;
      return;
    }
    fields.set(path, {
      path,
      types: new Set([type]),
      records: new Set([recordIndex]),
      sensitiveCategory: category,
    });
  };

  const visit = (
    value: unknown,
    path: string,
    depth: number,
    recordIndex: number,
    category: YonyouSensitiveFieldCategory | null,
  ): void => {
    if (depth > FIELD_PROFILE_DEPTH_LIMIT) {
      truncated = true;
      return;
    }
    if (path) recordField(path, valueType(value), recordIndex, category);
    if (Array.isArray(value)) {
      const nested = sampleArray(value, FIELD_PROFILE_NESTED_ARRAY_LIMIT);
      if (nested.length < value.length) truncated = true;
      for (const item of nested) visit(item, `${path}[]`, depth + 1, recordIndex, category);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nextPath = path ? `${path}.${safePathSegment(key)}` : safePathSegment(key);
      visit(
        (value as Record<string, unknown>)[key],
        nextPath,
        depth + 1,
        recordIndex,
        sensitiveCategory(key),
      );
    }
  };

  sampled.forEach((record, index) => visit(record, "", 0, index, null));
  const entries = [...fields.values()]
    .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"))
    .map((field): YonyouFieldProfileEntry => ({
      path: field.path,
      types: [...field.types].sort(),
      presentInRecords: field.records.size,
      optional: field.records.size < sampled.length,
      nullable: field.types.has("null"),
      sensitiveCategory: field.sensitiveCategory,
    }));
  const categories = new Set(
    entries.flatMap((entry) => entry.sensitiveCategory ? [entry.sensitiveCategory] : []),
  );
  return {
    version: "yonyou-field-profile/v1",
    totalRecords: records.length,
    sampledRecords: sampled.length,
    fieldCount: entries.length,
    sensitiveFieldCount: entries.filter((entry) => entry.sensitiveCategory !== null).length,
    sensitiveCategories: [...categories].sort(),
    truncated,
    fields: entries,
  };
}

function fieldProfileFromScope(value: unknown): YonyouFieldProfile | null {
  const profile = scopeObject(value).fieldProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  return (profile as Record<string, unknown>).version === "yonyou-field-profile/v1"
    ? profile as YonyouFieldProfile
    : null;
}

function scopeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function scopeText(value: unknown, key: string): string | null {
  const candidate = scopeObject(value)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function summarizeFieldProfile(profile: YonyouFieldProfile | null): YonyouFieldProfileSummary | null {
  if (!profile) return null;
  const { fields: _fields, ...summary } = profile;
  return summary;
}

/** 尽力找出"记录数组"在哪；找不到就诚实返回 null，不猜。 */
export function extractRecordArray(data: Record<string, unknown>): unknown[] | null {
  for (const key of ["recordList", "rows", "list", "data", "records", "content", "pageList"]) {
    const candidate = data[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      for (const inner of ["recordList", "rows", "list", "records", "content"]) {
        const nested = (candidate as Record<string, unknown>)[inner];
        if (Array.isArray(nested)) return nested;
      }
    }
  }
  return null;
}

async function assertActor(db: AnyDb, actorId: number): Promise<void> {
  const [actor]: { id: number }[] = await db
    .select({ id: users.id }).from(users).where(eq(users.id, actorId)).limit(1);
  if (!actor) throw new Error(`用友同步执行人 ${actorId} 不存在`);
}

async function priorRun(db: AnyDb, idempotencyKey: string): Promise<PriorRun | null> {
  const [run]: PriorRun[] = await db
    .select({
      id: integrationRuns.id,
      status: integrationRuns.status,
      startedAt: integrationRuns.startedAt,
      importJobId: integrationRuns.importJobId,
      sourceRows: integrationRuns.sourceRows,
      stagedRows: integrationRuns.stagedRows,
      rejectedRows: integrationRuns.rejectedRows,
      evidenceHash: integrationRuns.evidenceHash,
      evidencePath: integrationRuns.evidencePath,
      error: integrationRuns.error,
      requestScope: integrationRuns.requestScope,
    })
    .from(integrationRuns)
    .where(eq(integrationRuns.idempotencyKey, idempotencyKey))
    .limit(1);
  return run ?? null;
}

async function claimRun(
  db: AnyDb,
  values: typeof integrationRuns.$inferInsert,
): Promise<{ id: number; startedAt: Date } | null> {
  const startedAt = new Date();
  const observed = await priorRun(db, String(values.idempotencyKey));
  if (!observed) {
    const [inserted]: { id: number; startedAt: Date }[] = await db
      .insert(integrationRuns)
      .values({ ...values, startedAt })
      .onConflictDoNothing()
      .returning({ id: integrationRuns.id, startedAt: integrationRuns.startedAt });
    if (inserted) return inserted;
  }
  const existing = observed ?? await priorRun(db, String(values.idempotencyKey));
  if (!existing) return null;
  const awaitingGrant = isYonyouAuthorizationWait(existing);
  const stale = existing.status === "running"
    && startedAt.getTime() - existing.startedAt.getTime() >= RUN_STALE_AFTER_MS;
  if (existing.status !== "failed" && !stale && !awaitingGrant) return null;

  // startedAt 是租约栅栏，不只是展示时间。快速重试也必须改变，避免同毫秒 ABA。
  const nextStartedAt = new Date(Math.max(startedAt.getTime(), existing.startedAt.getTime() + 1));

  const [reclaimed]: { id: number; startedAt: Date }[] = await db
    .update(integrationRuns)
    .set({
      ...values,
      status: "running",
      sourceRows: 0,
      stagedRows: 0,
      rejectedRows: 0,
      importJobId: null,
      evidenceHash: null,
      evidencePath: null,
      requestScope: null,
      cursorStart: null,
      cursorEnd: null,
      error: null,
      startedAt: nextStartedAt,
      finishedAt: null,
    })
    .where(and(
      eq(integrationRuns.id, existing.id),
      eq(integrationRuns.status, existing.status),
      eq(integrationRuns.startedAt, existing.startedAt),
      // 保留认领前的等待谓词，不能以旧快照接管已产生事实的成功运行。
      awaitingGrant ? and(
        eq(integrationRuns.error, existing.error!),
        isNull(integrationRuns.importJobId),
        eq(integrationRuns.sourceRows, 0),
        eq(integrationRuns.stagedRows, 0),
        eq(integrationRuns.rejectedRows, 0),
        sql`coalesce(${integrationRuns.evidenceHash}, '') = ''`,
        sql`coalesce(${integrationRuns.evidencePath}, '') = ''`,
      ) : undefined,
    ))
    .returning({ id: integrationRuns.id, startedAt: integrationRuns.startedAt });
  return reclaimed ?? null;
}

async function failRun(
  db: AnyDb,
  runId: number,
  attemptStartedAt: Date,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await db.update(integrationRuns).set({
    status: "failed",
    importJobId: null,
    error: message,
    finishedAt: new Date(Math.max(Date.now(), attemptStartedAt.getTime())),
  }).where(and(
    eq(integrationRuns.id, runId),
    eq(integrationRuns.status, "running"),
    eq(integrationRuns.startedAt, attemptStartedAt),
  ));
}

export interface YonyouSyncOptions {
  client: YonyouClient;
  contract: YonyouReadContractName;
  actorId: number;
  /** 请求体；分页由调用方决定，本模块不臆断分页参数名。 */
  request?: Record<string, unknown>;
  /** 幂等窗口标识（例如 bizDate）。真实成功才重放；等待授权可在下次调用安全重试。 */
  scopeKey: string;
  /** 明确的源业务/观察日期；与幂等键分离，禁止从任意 scopeKey 猜日期。 */
  sourceAsOf?: string;
}

function validSourceAsOf(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/**
 * 拉取一条契约并原样落 staging。
 *
 * 未授权（310037/310005）**不抛异常**：这是"等控制台授权"的正常中间态，
 * 抛错会让定时任务不断告警，把运维注意力从真正的故障上引开。
 * 该情况下 run 记为 succeeded 但不推进 checkpoint，且 blockedByConsoleGrant=true。
 */
export async function syncYonyouContract(
  db: AnyDb,
  options: YonyouSyncOptions,
): Promise<YonyouSyncSummary> {
  const { client, contract, actorId, scopeKey } = options;
  const sourceAsOf = options.sourceAsOf ?? null;
  if (sourceAsOf != null && !validSourceAsOf(sourceAsOf)) {
    throw new Error("用友 sourceAsOf 必须是有效的 YYYY-MM-DD 业务日期");
  }
  const request = options.request ?? {};
  const stream = streamOf(contract);
  const idempotencyKey = `${CONNECTOR}:${stream}:${scopeKey}`;

  await assertActor(db, actorId);

  const existing = await priorRun(db, idempotencyKey);
  if (existing?.status === "succeeded" && !isYonyouAuthorizationWait(existing)) {
    // 真实空响应也有 importJob。矛盾的历史记录不能伪装成功或被自动清除重拉。
    if (existing.importJobId === null || existing.error !== null) {
      throw new Error(`用友同步运行 #${existing.id} 成功状态与观察证据不一致，需人工核对`);
    }
    const existingScope = scopeObject(existing.requestScope);
    return {
      runId: existing.id,
      importJobId: existing.importJobId,
      contract,
      sourceRows: existing.sourceRows,
      stagedRows: existing.stagedRows,
      evidenceHash: existing.evidenceHash ?? "",
      shapeFingerprint: scopeText(existing.requestScope, "shapeFingerprint") ?? "",
      fieldProfileSummary: summarizeFieldProfile(fieldProfileFromScope(existing.requestScope)),
      schemaDrift: existingScope.schemaDrift === true,
      releaseBlocked: existingScope.releaseBlocked === true,
      replayed: true,
      blockedByConsoleGrant: false,
    };
  }

  const attempt = await claimRun(db, {
    connector: CONNECTOR,
    stream,
    status: "running",
    idempotencyKey,
  } as typeof integrationRuns.$inferInsert);
  if (!attempt) throw new Error(`用友 ${stream} 同步已被其他运行占用`);

  try {
    let data: Record<string, unknown>;
    try {
      data = await client.callContract(contract, request);
    } catch (error) {
      if (error instanceof YonyouApiError && error.needsConsoleGrant) {
        // 技术运行正常结束，但业务仍等待授权；不创建观察 job 或推进 checkpoint。
        const [claimed]: { id: number }[] = await db.update(integrationRuns).set({
          status: "succeeded",
          sourceRows: 0,
          stagedRows: 0,
          error: `待控制台授权：${error.code}`,
          finishedAt: new Date(Math.max(Date.now(), attempt.startedAt.getTime())),
        }).where(and(
          eq(integrationRuns.id, attempt.id),
          eq(integrationRuns.status, "running"),
          eq(integrationRuns.startedAt, attempt.startedAt),
        )).returning({ id: integrationRuns.id });
        if (!claimed) throw new Error("用友同步运行租约已被其他重试接管");
        return {
          runId: attempt.id,
          importJobId: null,
          contract,
          sourceRows: 0,
          stagedRows: 0,
          evidenceHash: "",
          shapeFingerprint: "",
          fieldProfileSummary: null,
          schemaDrift: false,
          releaseBlocked: false,
          replayed: false,
          blockedByConsoleGrant: true,
        };
      }
      throw error;
    }

    const records = extractRecordArray(data);
    const shapeFingerprint = yonyouShapeFingerprint(data);
    const rows: unknown[] = records ?? [data];
    const fieldProfile = profileYonyouFields(rows);
    const envelope = {
      contract,
      connector: CONNECTOR,
      stream,
      schemaVersion: SCHEMA_VERSION,
      scope: { scopeKey, request },
      shapeFingerprint,
      fieldProfile,
      data,
    };
    const evidence = await writeIntegrationEvidence(CONNECTOR, stream, envelope);

    // 找不到记录数组时，把整个 data 当作一行原样落库——诚实优于臆测分页结构
    const stagingRowsInput: StagingRowInput[] = rows.map((row, index) => ({
      rowNo: index + 1,
      targetTable: TARGET_TABLE,
      payload: {
        contract,
        shapeFingerprint: yonyouShapeFingerprint(row),
        // 原样保留，不裁剪不改名：字段语义未知，任何加工都可能丢信息
        raw: row,
      },
      status: "pending",
    }));

    const finishedAt = new Date(Math.max(Date.now(), attempt.startedAt.getTime()));
    // 事务闭包内产生的 jobId 要带出来；用函数内局部变量，切忌模块级共享（并发会串号）
    let stagedJobId: number | null = null;
    let schemaDrift = false;
    await db.transaction(async (tx: AnyDb) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${CONNECTOR}:${stream}`}))`);

      const [newer]: { id: number }[] = await tx
        .select({ id: integrationRuns.id })
        .from(integrationRuns)
        .where(and(
          inArray(integrationRuns.connector, [CONNECTOR, "yonyou"]),
          eq(integrationRuns.stream, stream),
          eq(integrationRuns.status, "succeeded"),
          isNotNull(integrationRuns.importJobId),
          gt(integrationRuns.id, attempt.id),
        ))
        .orderBy(desc(integrationRuns.id))
        .limit(1);
      if (newer) throw new Error(`用友 ${stream} 已有更新成功运行 #${newer.id}，拒绝较旧运行覆盖`);

      // 基线只取同一契约版本中最后一个未阻断、且确实落过业务观察 job 的结构。
      // 漂移批次不会成为下一批的基线，因此不会因连续两天返回同一新结构而自动解封。
      // 若业务确认新结构，必须在受评审代码中升级 SCHEMA_VERSION，再建立新基线。
      const [baseline]: { id: number; requestScope: unknown }[] = await tx
        .select({ id: integrationRuns.id, requestScope: integrationRuns.requestScope })
        .from(integrationRuns)
        .where(and(
          inArray(integrationRuns.connector, [CONNECTOR, "yonyou"]),
          eq(integrationRuns.stream, stream),
          eq(integrationRuns.status, "succeeded"),
          isNotNull(integrationRuns.importJobId),
          lt(integrationRuns.id, attempt.id),
          isNull(integrationRuns.error),
          sql`coalesce(${integrationRuns.requestScope} ->> 'schemaVersion', '') = ${SCHEMA_VERSION}`,
          sql`coalesce(${integrationRuns.requestScope} ->> 'shapeFingerprint', '') <> ''`,
          sql`coalesce(${integrationRuns.requestScope} ->> 'releaseBlocked', 'false') <> 'true'`,
        ))
        .orderBy(desc(integrationRuns.startedAt), desc(integrationRuns.id))
        .limit(1);
      const baselineFingerprint = baseline
        ? scopeText(baseline.requestScope, "shapeFingerprint")
        : null;
      schemaDrift = baselineFingerprint !== null && baselineFingerprint !== shapeFingerprint;
      const controlledScope = {
        contract,
        scopeKey,
        sourceAsOf,
        schemaVersion: SCHEMA_VERSION,
        shapeFingerprint,
        fieldProfile,
        schemaDrift,
        schemaBaselineRunId: baseline?.id ?? null,
        releaseBlocked: schemaDrift,
      };

      const job = await createSourceImportJobInTransaction(tx, {
        template: TARGET_TABLE,
        sourceName: `${stream}-${scopeKey}.json`,
        sourceBytes: evidence.bytes,
        createdBy: actorId,
        idempotencyKey,
        sourceAsOf,
        schemaVersion: SCHEMA_VERSION,
        scope: controlledScope,
      });
      await writeStagingRows(tx, job.id, stagingRowsInput);
      await finalizeImportJob(tx, job.id, {
        okRows: stagingRowsInput.length,
        failRows: 0,
        status: "done",
      });

      const [claimed]: { id: number }[] = await tx.update(integrationRuns).set({
        status: "succeeded",
        importJobId: job.id,
        sourceRows: rows.length,
        stagedRows: stagingRowsInput.length,
        rejectedRows: 0,
        evidenceHash: evidence.hash,
        requestScope: { ...controlledScope, request },
        cursorEnd: scopeKey,
        error: null,
        finishedAt,
      }).where(and(
        eq(integrationRuns.id, attempt.id),
        eq(integrationRuns.status, "running"),
        eq(integrationRuns.startedAt, attempt.startedAt),
      )).returning({ id: integrationRuns.id });
      if (!claimed) throw new Error("用友同步运行租约已被其他重试接管");

      await tx.insert(integrationCheckpoints).values({
        connector: CONNECTOR,
        stream,
        cursor: scopeKey,
        lastRunId: attempt.id,
        lastSuccessAt: finishedAt,
        updatedAt: finishedAt,
      }).onConflictDoUpdate({
        target: [integrationCheckpoints.connector, integrationCheckpoints.stream],
        set: {
          cursor: scopeKey,
          version: sql`${integrationCheckpoints.version} + 1`,
          lastRunId: attempt.id,
          lastSuccessAt: finishedAt,
          updatedAt: finishedAt,
        },
      });

      stagedJobId = job.id;
    });

    return {
      runId: attempt.id,
      importJobId: stagedJobId,
      contract,
      sourceRows: rows.length,
      stagedRows: stagingRowsInput.length,
      evidenceHash: evidence.hash,
      shapeFingerprint,
      fieldProfileSummary: summarizeFieldProfile(fieldProfile),
      schemaDrift,
      releaseBlocked: schemaDrift,
      replayed: false,
      blockedByConsoleGrant: false,
    };
  } catch (error) {
    await failRun(db, attempt.id, attempt.startedAt, error);
    throw error;
  }
}
