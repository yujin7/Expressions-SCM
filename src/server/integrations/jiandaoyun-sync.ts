import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  importJobs,
  integrationCheckpoints,
  integrationRuns,
  stagingRows,
  users,
} from "@/db/schema";
import {
  createSourceImportJobInTransaction,
  finalizeImportJob,
  supersedeSourceObservationJobsInTransaction,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "@/server/import/staging";
import { resolveKnownOrQueue, resolveSkuByBarcode, type DimDb } from "@/server/modules/dimension/resolver";
import {
  jiandaoyunContractProjection,
  jiandaoyunContractWidgets,
  type JiandaoyunFieldRule,
  type JiandaoyunFormContract,
  type JiandaoyunSubformRule,
} from "./jiandaoyun-contracts";
import {
  JiandaoyunClient,
  jiandaoyunSchemaHash,
  type JiandaoyunRecord,
} from "./jiandaoyun";
import {
  inspectJiandaoyunContractControl,
  summarizeJiandaoyunContractControl,
} from "./jiandaoyun-audit";
import { writeIntegrationEvidence, type IntegrationEvidence } from "./evidence";
import { resolveSourceAsOf } from "./source-time";

const CONNECTOR = "jdy";
const CATALOG_STREAM = "catalog";
const CATALOG_SCHEMA_VERSION = "jiandaoyun-catalog-v1";
const RECORD_SCHEMA_VERSION = "jiandaoyun-observation-v4";
/** Running claims older than this can be fenced off and recovered by a retry. */
const RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1_000;

export interface JiandaoyunCatalogSummary {
  runId: number;
  apps: number;
  forms: number;
  evidenceHash: string;
  replayed: boolean;
}

export interface JiandaoyunFormSummary {
  runId: number;
  importJobId: number;
  contractKey: string;
  sourceRows: number;
  stagedRows: number;
  schemaHash: string;
  sourceAsOf: string | null;
  unresolvedAliases: number;
  replayed: boolean;
}

interface PriorRun {
  id: number;
  status: string;
  startedAt: Date;
  importJobId: number | null;
  sourceRows: number;
  stagedRows: number;
  evidenceHash: string | null;
  requestScope: unknown;
}

async function assertActor(db: AnyDb, actorId: number): Promise<void> {
  const [actor]: { id: number; active: boolean }[] = await db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  if (!actor?.active) throw new Error("JIANDAOYUN_SYNC_ACTOR_ID 未指向有效启用用户");
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
      evidenceHash: integrationRuns.evidenceHash,
      requestScope: integrationRuns.requestScope,
    })
    .from(integrationRuns)
    .where(eq(integrationRuns.idempotencyKey, idempotencyKey))
    .limit(1);
  return run ?? null;
}

async function insertRun(
  db: AnyDb,
  values: typeof integrationRuns.$inferInsert,
): Promise<{ id: number; startedAt: Date } | null> {
  const [run]: { id: number; startedAt: Date }[] = await db
    .insert(integrationRuns)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: integrationRuns.id, startedAt: integrationRuns.startedAt });
  return run ?? null;
}

interface RunAttempt {
  id: number;
  startedAt: Date;
  recovered: boolean;
}

/**
 * Claim an immutable source envelope. Failed claims retry immediately; abandoned running claims
 * retry after the lease window. `startedAt` is the fencing token that prevents the old worker from
 * committing after a recovery has begun.
 */
async function claimRun(
  db: AnyDb,
  values: typeof integrationRuns.$inferInsert,
  observed: PriorRun | null,
): Promise<RunAttempt | null> {
  const startedAt = new Date();
  if (!observed) {
    const inserted = await insertRun(db, { ...values, startedAt });
    if (inserted) return { ...inserted, recovered: false };
  }

  const existing = observed ?? await priorRun(db, String(values.idempotencyKey));
  if (!existing || existing.status === "succeeded") return null;
  const stale = existing.status === "running"
    && startedAt.getTime() - existing.startedAt.getTime() >= RUN_STALE_AFTER_MS;
  if (existing.status !== "failed" && !stale) return null;

  const [reclaimed]: { id: number; startedAt: Date }[] = await db
    .update(integrationRuns)
    .set({
      ...values,
      status: "running",
      sourceRows: values.sourceRows ?? 0,
      stagedRows: 0,
      rejectedRows: 0,
      importJobId: null,
      error: null,
      startedAt,
      finishedAt: null,
    })
    .where(and(
      eq(integrationRuns.id, existing.id),
      eq(integrationRuns.status, existing.status),
      eq(integrationRuns.startedAt, existing.startedAt),
    ))
    .returning({ id: integrationRuns.id, startedAt: integrationRuns.startedAt });
  return reclaimed ? { ...reclaimed, recovered: true } : null;
}

interface FinishRunInput {
  runId: number;
  attemptStartedAt: Date;
  stream: string;
  cursor: string;
  importJobId?: number | null;
  sourceRows: number;
  stagedRows: number;
  requestScope: Record<string, unknown>;
  /** Empty/non-authoritative observations are evidence, not a new accepted source position. */
  advanceCheckpoint?: boolean;
}

async function finishRunInTransaction(
  tx: AnyDb,
  input: FinishRunInput,
): Promise<void> {
  const finishedAt = new Date();
  const [claimed]: { id: number }[] = await tx
    .update(integrationRuns)
    .set({
      status: "succeeded",
      importJobId: input.importJobId ?? null,
      sourceRows: input.sourceRows,
      stagedRows: input.stagedRows,
      rejectedRows: 0,
      requestScope: input.requestScope,
      cursorEnd: input.cursor,
      error: null,
      finishedAt,
    })
    .where(and(
      eq(integrationRuns.id, input.runId),
      eq(integrationRuns.status, "running"),
      eq(integrationRuns.startedAt, input.attemptStartedAt),
    ))
    .returning({ id: integrationRuns.id });
  if (!claimed) throw new Error("简道云同步运行租约已被其他重试接管");

  if (input.advanceCheckpoint === false) return;

  await tx
    .insert(integrationCheckpoints)
    .values({
      connector: CONNECTOR,
      stream: input.stream,
      cursor: input.cursor,
      lastRunId: input.runId,
      lastSuccessAt: finishedAt,
      updatedAt: finishedAt,
    })
    .onConflictDoUpdate({
      target: [integrationCheckpoints.connector, integrationCheckpoints.stream],
      set: {
        cursor: input.cursor,
        version: sql`${integrationCheckpoints.version} + 1`,
        lastRunId: input.runId,
        lastSuccessAt: finishedAt,
        updatedAt: finishedAt,
      },
    });
}

async function lockStreamCommit(tx: AnyDb, stream: string): Promise<void> {
  // All accepted envelopes for a logical stream share this transaction-scoped lock. `hashtext`
  // collisions can only serialize unrelated streams; they cannot let two same-stream commits race.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${CONNECTOR}:${stream}`}))`);
}

async function assertNoNewerSucceededRun(
  tx: AnyDb,
  stream: string,
  runId: number,
): Promise<void> {
  const [newerCommitted]: { id: number }[] = await tx
    .select({ id: integrationRuns.id })
    .from(integrationRuns)
    .where(and(
      eq(integrationRuns.connector, CONNECTOR),
      eq(integrationRuns.stream, stream),
      eq(integrationRuns.status, "succeeded"),
      gt(integrationRuns.id, runId),
    ))
    .orderBy(desc(integrationRuns.id))
    .limit(1);
  if (newerCommitted) {
    throw new Error(`简道云 ${stream} 已有更新成功运行 #${newerCommitted.id}，拒绝较旧运行覆盖`);
  }
}

async function failRun(
  db: AnyDb,
  runId: number,
  attemptStartedAt: Date,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await db
    .update(integrationRuns)
    .set({
      status: "failed",
      importJobId: null,
      error: message,
      finishedAt: new Date(),
    })
    .where(and(
      eq(integrationRuns.id, runId),
      eq(integrationRuns.status, "running"),
      eq(integrationRuns.startedAt, attemptStartedAt),
    ));
}

function scopeObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function catalogReplay(run: PriorRun): JiandaoyunCatalogSummary | null {
  if (run.status !== "succeeded" || !run.evidenceHash) return null;
  const scope = scopeObject(run.requestScope);
  return {
    runId: run.id,
    apps: Number(scope.apps ?? 0),
    forms: Number(scope.forms ?? 0),
    evidenceHash: run.evidenceHash,
    replayed: true,
  };
}

export async function syncJiandaoyunCatalog(
  db: AnyDb,
  input: {
    client: JiandaoyunClient;
    actorId: number;
    writeEvidence?: (
      connector: string,
      stream: string,
      envelope: unknown,
    ) => Promise<IntegrationEvidence>;
  },
): Promise<JiandaoyunCatalogSummary> {
  await assertActor(db, input.actorId);
  const apps = await input.client.listApps();
  const catalog = [];
  for (const app of apps) {
    catalog.push({ ...app, forms: await input.client.listForms(app.appId) });
  }
  const forms = catalog.reduce((sum, app) => sum + app.forms.length, 0);
  const envelope = {
    contract: CATALOG_SCHEMA_VERSION,
    connector: CONNECTOR,
    scope: {
      authority: "metadata-only",
      appViews: "all-visible-to-api-key",
      dataRowsIncluded: false,
    },
    apps: catalog,
  };
  const evidence = await (input.writeEvidence ?? writeIntegrationEvidence)(
    CONNECTOR,
    CATALOG_STREAM,
    envelope,
  );
  const idempotencyKey = `${CONNECTOR}:${CATALOG_STREAM}:${evidence.hash}`;
  const existing = await priorRun(db, idempotencyKey);
  const replay = existing ? catalogReplay(existing) : null;
  if (replay) return replay;
  const runValues = {
    connector: CONNECTOR,
    stream: CATALOG_STREAM,
    idempotencyKey,
    cursorStart: null,
    cursorEnd: evidence.hash,
    requestScope: { apps: apps.length, forms, authority: "metadata-only" },
    evidencePath: evidence.relativePath,
    evidenceHash: evidence.hash,
    sourceRows: forms,
  } satisfies typeof integrationRuns.$inferInsert;
  const run = await claimRun(db, runValues, existing);
  if (!run) {
    const concurrent = await priorRun(db, idempotencyKey);
    const concurrentReplay = concurrent ? catalogReplay(concurrent) : null;
    if (concurrentReplay) return concurrentReplay;
    throw new Error("相同简道云目录信封正在处理；超出租约后会自动恢复");
  }
  try {
    await db.transaction(async (tx: AnyDb) => {
      await lockStreamCommit(tx, CATALOG_STREAM);
      await assertNoNewerSucceededRun(tx, CATALOG_STREAM, run.id);
      await finishRunInTransaction(tx, {
        runId: run.id,
        attemptStartedAt: run.startedAt,
        stream: CATALOG_STREAM,
        cursor: evidence.hash,
        sourceRows: forms,
        stagedRows: 0,
        requestScope: { apps: apps.length, forms, authority: "metadata-only" },
      });
    });
    return {
      runId: run.id,
      apps: apps.length,
      forms,
      evidenceHash: evidence.hash,
      replayed: false,
    };
  } catch (error) {
    await failRun(db, run.id, run.startedAt, error);
    throw error;
  }
}

function unwrap(value: unknown): unknown {
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return (value as Record<string, unknown>).value;
  }
  return value;
}

function jsonValue(value: unknown): unknown {
  const unwrapped = unwrap(value);
  if (
    unwrapped == null
    || typeof unwrapped === "string"
    || typeof unwrapped === "number"
    || typeof unwrapped === "boolean"
  ) return unwrapped;
  if (Array.isArray(unwrapped)) return unwrapped.map(jsonValue);
  if (typeof unwrapped === "object") {
    return Object.fromEntries(
      Object.entries(unwrapped as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return String(unwrapped);
}

function mappedFields(
  source: Record<string, unknown>,
  rules: JiandaoyunFieldRule[],
): Record<string, unknown> {
  return Object.fromEntries(
    rules.map((rule) => [rule.target, jsonValue(source[rule.source])]),
  );
}

function subformRows(
  source: Record<string, unknown>,
  rule: JiandaoyunSubformRule,
): Record<string, unknown>[] {
  const value = unwrap(source[rule.source]);
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`简道云子表 ${rule.source} 不是数组`);
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`简道云子表 ${rule.source}[${index}] 结构非法`);
    }
    return mappedFields(raw as Record<string, unknown>, rule.items);
  });
}

function minimizeRecord(
  record: JiandaoyunRecord,
  contract: JiandaoyunFormContract,
): Record<string, unknown> {
  return {
    sourceRecordId: record._id,
    sourceCreatedAt: jsonValue(record.createTime ?? record.create_time ?? null),
    sourceUpdatedAt: jsonValue(record.updateTime ?? record.update_time ?? null),
    sourceDeletedAt: jsonValue(record.deleteTime ?? record.delete_time ?? null),
    data: {
      ...mappedFields(record, contract.fields),
      ...Object.fromEntries(
        (contract.subforms ?? []).map((rule) => [rule.target, subformRows(record, rule)]),
      ),
    },
  };
}

async function assertStableContractSchema(
  db: AnyDb,
  stream: string,
  schemaHash: string,
): Promise<void> {
  const [prior]: { requestScope: unknown }[] = await db
    .select({ requestScope: integrationRuns.requestScope })
    .from(integrationRuns)
    .where(and(
      eq(integrationRuns.connector, CONNECTOR),
      eq(integrationRuns.stream, stream),
      eq(integrationRuns.status, "succeeded"),
    ))
    .orderBy(desc(integrationRuns.id))
    .limit(1);
  if (!prior) return;
  const priorHash = scopeObject(prior.requestScope).schemaHash;
  if (typeof priorHash === "string" && priorHash !== "" && priorHash !== schemaHash) {
    throw new Error(
      `简道云字段契约 schema hash 已变化（${priorHash.slice(0, 12)} → ${schemaHash.slice(0, 12)}），需复核并建立新契约版本`,
    );
  }
}

/**
 * 源时点。**排除录入错误造成的未来日期**——简道云真实数据里存在 2051-07-31、
 * 2028-11-12 这类脏行；一条就能把整批 sourceAsOf 顶到 2051，
 * 进而让该批次被 month-close 的月份区间过滤排除在所有合法月份之外。
 * 详见 source-time.ts 的取值纪律。
 */
function sourceUpdatedThrough(records: JiandaoyunRecord[]): string | null {
  return resolveSourceAsOf(
    records.map((record) => String(record.updateTime ?? record.update_time ?? "")),
  ).sourceAsOf;
}

async function assertPriorSourceRecordContinuity(
  tx: AnyDb,
  input: {
    stream: string;
    priorJobId: number;
    expectedRows: number;
    currentSourceRecordIds: ReadonlySet<string>;
  },
): Promise<number> {
  const priorRows: { sourceRecordId: string | null }[] = await tx
    .select({
      sourceRecordId: sql<string | null>`${stagingRows.payload} ->> 'sourceRecordId'`,
    })
    .from(stagingRows)
    .where(eq(stagingRows.importJobId, input.priorJobId));
  const priorSourceRecordIds = new Set<string>();
  let rowsWithoutIdentity = 0;
  for (const row of priorRows) {
    const sourceRecordId = row.sourceRecordId?.trim() ?? "";
    if (!sourceRecordId) {
      rowsWithoutIdentity++;
      continue;
    }
    priorSourceRecordIds.add(sourceRecordId);
  }
  if (
    priorRows.length !== input.expectedRows
    || priorSourceRecordIds.size !== input.expectedRows
    || rowsWithoutIdentity > 0
  ) {
    throw new Error(
      `简道云 ${input.stream} 旧观察批次 #${input.priorJobId} 的 sourceRecordId 清单不完整，需人工复核后再替代`,
    );
  }
  let missingPriorRecords = 0;
  for (const sourceRecordId of priorSourceRecordIds) {
    if (!input.currentSourceRecordIds.has(sourceRecordId)) missingPriorRecords++;
  }
  if (missingPriorRecords > 0) {
    throw new Error(
      `简道云 ${input.stream} 新观察缺少旧记录 ${missingPriorRecords} 条；当前没有受支持的删除墓碑，拒绝替代批次 #${input.priorJobId}`,
    );
  }
  return priorSourceRecordIds.size;
}

function formReplay(
  run: PriorRun,
  contract: JiandaoyunFormContract,
): JiandaoyunFormSummary | null {
  if (run.status !== "succeeded" || !run.importJobId) return null;
  const scope = scopeObject(run.requestScope);
  return {
    runId: run.id,
    importJobId: run.importJobId,
    contractKey: contract.key,
    sourceRows: run.sourceRows,
    stagedRows: run.stagedRows,
    schemaHash: String(scope.schemaHash ?? ""),
    sourceAsOf: typeof scope.sourceAsOf === "string" ? scope.sourceAsOf : null,
    unresolvedAliases: Number(scope.unresolvedAliases ?? 0),
    replayed: true,
  };
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

async function resolveObservationIdentities(
  db: AnyDb,
  contract: JiandaoyunFormContract,
  record: Record<string, unknown>,
): Promise<{ resolved: Record<string, unknown>; unresolved: string[] }> {
  const data = scopeObject(record.data);
  const sourceRecordId = String(record.sourceRecordId ?? "");
  const resolved: Record<string, unknown> = {};
  const unresolved: string[] = [];
  const resolve = async (
    aliasType: "sku_code" | "sku_barcode" | "warehouse" | "supplier_oem",
    raw: unknown,
    path: string,
  ): Promise<number | null> => {
    const value = stringValue(raw);
    if (!value) return null;
    const targetId = await resolveKnownOrQueue(db as DimDb, aliasType, value, {
      connector: CONNECTOR,
      contractKey: contract.key,
      appId: contract.appId,
      entryId: contract.entryId,
      sourceRecordId,
      field: path,
    }, { scope: "JIANDAOYUN" });
    if (targetId === null) unresolved.push(`${path}=${value}`);
    return targetId;
  };

  const skuId = await resolve("sku_code", data.productCode, "productCode");
  if (skuId !== null) resolved.skuId = skuId;

  /*
   * 条码桥（2026-08-04）：平台商品的「商家编码」与系统 SKU 编码是两套命名空间
   * （拼多多 `SW1557` vs 系统 `N006-001`，5,376 个 SKU 里形如前者的有 0 个），
   * 但**条码是通的**——唯品会 405 个唯一条码有 169 个命中 skus.barcode。
   * 故 productCode 解析不到时，用条码再试一次；仍不中的照常进认领队列。
   *
   * 只做精确、唯一命中；同条码落在多个 SKU 上视为歧义，不挑、交人裁决。
   */
  if (resolved.skuId === undefined && data.barcode != null) {
    const barcode = stringValue(data.barcode);
    if (barcode) {
      const byBarcode = await resolveSkuByBarcode(db as DimDb, barcode);
      if (byBarcode !== null) {
        resolved.skuId = byBarcode;
      } else {
        await resolve("sku_barcode", barcode, "barcode");
      }
    }
  }
  const supplierCandidate = ([
    ["supplierCode", data.supplierCode],
    ["supplierName", data.supplierName],
    ["supplier", data.supplier],
  ] as const).find(([, value]) => stringValue(value) !== null);
  const supplierId = await resolve(
    "supplier_oem",
    supplierCandidate?.[1],
    supplierCandidate?.[0] ?? "supplier",
  );
  if (supplierId !== null) resolved.supplierId = supplierId;
  for (const key of ["warehouse", "fromWarehouse", "toWarehouse"] as const) {
    const warehouseId = await resolve("warehouse", data[key], key);
    if (warehouseId !== null) resolved[`${key}Id`] = warehouseId;
  }
  const warehouseMasterRaw = data.warehouseCode ?? data.warehouseName;
  if (warehouseMasterRaw != null) {
    const warehouseId = await resolve(
      "warehouse",
      warehouseMasterRaw,
      data.warehouseCode ? "warehouseCode" : "warehouseName",
    );
    if (warehouseId !== null) resolved.warehouseId = warehouseId;
  }

  for (const key of ["lines", "existingProductLines", "newProductLines"] as const) {
    const lines = data[key];
    if (!Array.isArray(lines)) continue;
    resolved[key] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = scopeObject(lines[index]);
      const lineSkuId = await resolve(
        "sku_code",
        line.productCode,
        `${key}[${index}].productCode`,
      );
      (resolved[key] as Array<Record<string, unknown>>).push(
        lineSkuId === null ? {} : { skuId: lineSkuId },
      );
    }
  }
  return { resolved, unresolved };
}

export async function syncJiandaoyunForm(
  db: AnyDb,
  input: {
    client: JiandaoyunClient;
    actorId: number;
    contract: JiandaoyunFormContract;
    writeEvidence?: (
      connector: string,
      stream: string,
      envelope: unknown,
    ) => Promise<IntegrationEvidence>;
  },
): Promise<JiandaoyunFormSummary> {
  await assertActor(db, input.actorId);
  const widgets = await input.client.listWidgets(input.contract.appId, input.contract.entryId);
  const schemaHash = jiandaoyunSchemaHash(
    jiandaoyunContractWidgets(input.contract, widgets),
  );
  await assertStableContractSchema(db, input.contract.key, schemaHash);
  const projection = jiandaoyunContractProjection(input.contract);
  const records = await input.client.listRecords(
    input.contract.appId,
    input.contract.entryId,
    projection,
    input.contract.window ? {
      field: input.contract.window.field,
      sinceDays: input.contract.window.days,
      // 拼多多订单会在下单数日后才取消/退款；同步近期更新可撤销旧的付款观察。
      includeUpdatedSince: input.contract.key === "pdd-order-observation",
    } : undefined,
  );
  const control = inspectJiandaoyunContractControl(input.contract, widgets, records);
  const controlSummary = summarizeJiandaoyunContractControl(control);
  const minimized = records
    .map((record) => minimizeRecord(record, input.contract))
    .sort((left, right) =>
      String(left.sourceRecordId).localeCompare(String(right.sourceRecordId), "en"));
  const sourceRecordIds = new Set<string>();
  for (const record of minimized) {
    const sourceRecordId = String(record.sourceRecordId ?? "");
    if (!sourceRecordId) throw new Error("简道云返回了缺少 _id 的记录，拒绝形成观察批次");
    if (sourceRecordIds.has(sourceRecordId)) {
      throw new Error(`简道云分页返回重复记录 ${sourceRecordId}，源视图可能在读取中变化`);
    }
    sourceRecordIds.add(sourceRecordId);
  }
  const updatedThrough = sourceUpdatedThrough(records);
  const asOf = updatedThrough?.slice(0, 10) ?? null;
  const stream = input.contract.key;
  const envelope = {
    contract: RECORD_SCHEMA_VERSION,
    connector: CONNECTOR,
    stream,
    scope: {
      appId: input.contract.appId,
      entryId: input.contract.entryId,
      schemaHash,
      sourceUpdatedThrough: updatedThrough,
      completeness: "paginated-authorized-observation",
      consistency: "source-has-no-snapshot-token",
      controlRows: minimized.length,
      uniqueSourceRecordIds: sourceRecordIds.size,
      authority: "observation-only",
      fieldMinimized: true,
      sourceProjection: projection,
      window: input.contract.window ?? null,
      controlSummary,
    },
    records: minimized,
  };
  const evidence = await (input.writeEvidence ?? writeIntegrationEvidence)(
    CONNECTOR,
    stream,
    envelope,
  );
  const idempotencyKey = `${CONNECTOR}:${stream}:${evidence.hash}`;
  const existing = await priorRun(db, idempotencyKey);
  const replay = existing ? formReplay(existing, input.contract) : null;
  if (replay) return replay;
  const runValues = {
    connector: CONNECTOR,
    stream,
    idempotencyKey,
    cursorStart: null,
    cursorEnd: evidence.hash,
    requestScope: {
      contractKey: input.contract.key,
      appId: input.contract.appId,
      entryId: input.contract.entryId,
      schemaHash,
      sourceAsOf: asOf,
      sourceUpdatedThrough: updatedThrough,
      authority: "observation-only",
      controlSummary,
      qualityBlocked: controlSummary.status === "review",
      window: input.contract.window ?? null,
    },
    evidencePath: evidence.relativePath,
    evidenceHash: evidence.hash,
    sourceRows: minimized.length,
  } satisfies typeof integrationRuns.$inferInsert;
  const run = await claimRun(db, runValues, existing);
  if (!run) {
    const concurrent = await priorRun(db, idempotencyKey);
    const concurrentReplay = concurrent ? formReplay(concurrent, input.contract) : null;
    if (concurrentReplay) return concurrentReplay;
    throw new Error("相同简道云表单信封正在处理；超出租约后会自动恢复");
  }

  try {
    const committed = await db.transaction(async (tx: AnyDb) => {
      await lockStreamCommit(tx, stream);
      await assertNoNewerSucceededRun(tx, stream, run.id);
      // A concurrent first run may have established the schema after the pre-fetch check.
      await assertStableContractSchema(tx, stream, schemaHash);

      const priorCandidates: Array<{
        id: number;
        controlRows: number | null;
        sourceAsOf: string | null;
        scope: unknown;
      }> = await tx
        .select({
          id: importJobs.id,
          controlRows: importJobs.controlRows,
          sourceAsOf: importJobs.sourceAsOf,
          scope: importJobs.scope,
        })
        .from(importJobs)
        .where(and(
          eq(importJobs.template, input.contract.targetTable),
          eq(importJobs.status, "done"),
        ))
        .orderBy(desc(importJobs.id));
      const priorFull = priorCandidates.find((candidate) => {
        const scope = scopeObject(candidate.scope);
        return candidate.controlRows !== null
          && candidate.controlRows > 0
          && scope.connector === CONNECTOR
          && scope.stream === stream
          && scope.mode === "full"
          && scope.authority === "observation-only"
          && scope.releaseBlocked === true;
      });
      let priorSourceRecordIdsVerified = 0;
      if (minimized.length > 0 && priorFull) {
        const priorScope = scopeObject(priorFull.scope);
        const priorUpdatedThrough = typeof priorScope.sourceUpdatedThrough === "string"
          ? priorScope.sourceUpdatedThrough
          : priorFull.sourceAsOf === null ? null : `${priorFull.sourceAsOf}T00:00:00.000Z`;
        if (priorUpdatedThrough !== null && updatedThrough === null) {
          throw new Error(
            `简道云 ${stream} 新观察缺少源时点，不能替代批次 #${priorFull.id}`,
          );
        }
        if (
          priorUpdatedThrough !== null
          && updatedThrough !== null
          && updatedThrough < priorUpdatedThrough
        ) {
          throw new Error(
            `简道云 ${stream} 源时点回退（${updatedThrough} < ${priorUpdatedThrough}），拒绝覆盖`,
          );
        }
        // 时间窗契约（contract.window）每批只是"最近 N 天"的滚动快照：行数随窗口内业务量起伏、
        // 窗口外的记录本来就不再出现，"全量行数不得下降 / 旧记录必须仍在"这两条只适用于全量快照。
        // 2026-09-02 实测：拼多多订单 14 天批 42,256 行 → 3 天批 7,141 行被误判为"分页缩减"。
        if (!input.contract.window) {
          if (minimized.length < priorFull.controlRows!) {
            throw new Error(
              `简道云 ${stream} 全量行数下降（${minimized.length} < ${priorFull.controlRows}），可能是权限或分页缩减；需人工复核`,
            );
          }
          priorSourceRecordIdsVerified = await assertPriorSourceRecordContinuity(tx, {
            stream,
            priorJobId: priorFull.id,
            expectedRows: priorFull.controlRows!,
            currentSourceRecordIds: sourceRecordIds,
          });
        }
      }

      const job = await createSourceImportJobInTransaction(tx, {
        template: input.contract.targetTable,
        sourceName: `${CONNECTOR}-${stream}-${evidence.hash.slice(0, 12)}.json`,
        sourceBytes: evidence.bytes,
        createdBy: input.actorId,
        // Each source envelope is immutable. In particular, an empty/failed read must never
        // supersede the last review batch or imply that previously observed business facts are zero.
        idempotencyKey: `${input.contract.targetTable}:${evidence.hash}`,
        sourceAsOf: asOf,
        schemaVersion: RECORD_SCHEMA_VERSION,
        scope: {
          connector: CONNECTOR,
          stream,
          appId: input.contract.appId,
          entryId: input.contract.entryId,
          // 时间窗快照：读模型必须按业务键跨批次去重累加，不能把单批当全量
          ...(input.contract.window ? { window: { field: input.contract.window.field, days: input.contract.window.days } } : {}),
          schemaHash,
          sourceUpdatedThrough: updatedThrough,
          priorSourceRecordIdsVerified,
          deletionPolicy: "no-tombstone-fail-closed",
          mode: "full",
          authority: "observation-only",
          releaseBlocked: true,
          controlSummary,
          qualityBlocked: controlSummary.status === "review",
          evidencePath: evidence.relativePath,
          evidenceHash: evidence.hash,
        },
      });
      // Only a successful, non-empty full observation may retire prior review batches. An empty
      // response is retained as evidence but cannot imply that previously observed facts vanished.
      // 滚动窗口每批只覆盖最近 N 天，旧批次是 30/90 天累计历史的一部分，不能退役。
      // 只有非窗口的完整快照才能用新批次替换旧批次。
      const supersededImportJobs = minimized.length > 0 && !input.contract.window
        ? await supersedeSourceObservationJobsInTransaction(tx, {
          keepJobId: job.id,
          template: input.contract.targetTable,
          connector: CONNECTOR,
          stream,
        })
        : 0;
      const staged: StagingRowInput[] = [];
      let unresolvedAliases = 0;
      for (let index = 0; index < minimized.length; index++) {
        const record = minimized[index];
        const identity = await resolveObservationIdentities(tx, input.contract, record);
        unresolvedAliases += identity.unresolved.length;
        staged.push({
          rowNo: index + 1,
          targetTable: input.contract.targetTable,
          payload: {
            ...record,
            _source: {
              connector: CONNECTOR,
              contractKey: input.contract.key,
              appId: input.contract.appId,
              entryId: input.contract.entryId,
              schemaHash,
            },
            _identity: identity.resolved,
          },
          status: "pending",
          errorMsg: [
            "简道云只读观察：完成身份映射、控制总量与业务复核前禁止放行",
            identity.unresolved.length > 0
              ? `未解析别名: ${identity.unresolved.slice(0, 5).join("; ")}${identity.unresolved.length > 5 ? "…" : ""}`
              : null,
          ].filter(Boolean).join("；"),
        });
      }
      if (staged.length > 0) await writeStagingRows(tx, job.id, staged);
      await finalizeImportJob(tx, job.id, {
        okRows: staged.length,
        failRows: 0,
        controlRows: staged.length,
      });
      const requestScope = {
        contractKey: input.contract.key,
        appId: input.contract.appId,
        entryId: input.contract.entryId,
        schemaHash,
        sourceAsOf: asOf,
        sourceUpdatedThrough: updatedThrough,
        authority: "observation-only",
        releaseBlocked: true,
        emptySource: minimized.length === 0,
        priorSourceRecordIdsVerified,
        deletionPolicy: "no-tombstone-fail-closed",
        supersededImportJobs,
        unresolvedAliases,
        controlSummary,
        qualityBlocked: controlSummary.status === "review",
        window: input.contract.window ?? null,
      };
      await finishRunInTransaction(tx, {
        runId: run.id,
        attemptStartedAt: run.startedAt,
        stream,
        cursor: evidence.hash,
        importJobId: job.id,
        sourceRows: minimized.length,
        stagedRows: staged.length,
        requestScope,
        advanceCheckpoint: minimized.length > 0,
      });
      return { importJobId: job.id, stagedRows: staged.length, unresolvedAliases };
    });
    return {
      runId: run.id,
      importJobId: committed.importJobId,
      contractKey: input.contract.key,
      sourceRows: minimized.length,
      stagedRows: committed.stagedRows,
      schemaHash,
      sourceAsOf: asOf,
      unresolvedAliases: committed.unresolvedAliases,
      replayed: false,
    };
  } catch (error) {
    await failRun(db, run.id, run.startedAt, error);
    throw error;
  }
}
