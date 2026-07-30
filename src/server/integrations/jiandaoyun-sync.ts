import { and, desc, eq, sql } from "drizzle-orm";
import {
  importJobs,
  integrationCheckpoints,
  integrationRuns,
  users,
} from "@/db/schema";
import {
  createSourceImportJob,
  failImportJob,
  finalizeImportJob,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "@/server/import/staging";
import { resolveKnownOrQueue, type DimDb } from "@/server/modules/dimension/resolver";
import {
  type JiandaoyunFieldRule,
  type JiandaoyunFormContract,
  type JiandaoyunSubformRule,
} from "./jiandaoyun-contracts";
import {
  JiandaoyunClient,
  jiandaoyunSchemaHash,
  type JiandaoyunRecord,
  type JiandaoyunWidget,
} from "./jiandaoyun";
import { writeIntegrationEvidence, type IntegrationEvidence } from "./evidence";

const CONNECTOR = "jdy";
const CATALOG_STREAM = "catalog";
const CATALOG_SCHEMA_VERSION = "jiandaoyun-catalog-v1";
const RECORD_SCHEMA_VERSION = "jiandaoyun-observation-v1";

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
): Promise<{ id: number } | null> {
  const [run]: { id: number }[] = await db
    .insert(integrationRuns)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: integrationRuns.id });
  return run ?? null;
}

async function finishRun(
  db: AnyDb,
  input: {
    runId: number;
    stream: string;
    cursor: string;
    importJobId?: number | null;
    sourceRows: number;
    stagedRows: number;
    requestScope: Record<string, unknown>;
  },
): Promise<void> {
  const finishedAt = new Date();
  await db.transaction(async (tx: AnyDb) => {
    await tx
      .update(integrationRuns)
      .set({
        status: "succeeded",
        importJobId: input.importJobId ?? null,
        sourceRows: input.sourceRows,
        stagedRows: input.stagedRows,
        rejectedRows: 0,
        requestScope: input.requestScope,
        cursorEnd: input.cursor,
        finishedAt,
      })
      .where(eq(integrationRuns.id, input.runId));
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
  });
}

async function failRun(
  db: AnyDb,
  runId: number,
  error: unknown,
  importJobId: number | null = null,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await db
    .update(integrationRuns)
    .set({
      status: "failed",
      importJobId,
      error: message,
      finishedAt: new Date(),
    })
    .where(eq(integrationRuns.id, runId));
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
  if (existing) throw new Error("相同简道云目录信封正在处理或先前失败，请检查运行史");
  const run = await insertRun(db, {
    connector: CONNECTOR,
    stream: CATALOG_STREAM,
    idempotencyKey,
    cursorStart: null,
    cursorEnd: evidence.hash,
    requestScope: { apps: apps.length, forms, authority: "metadata-only" },
    evidencePath: evidence.relativePath,
    evidenceHash: evidence.hash,
    sourceRows: forms,
  });
  if (!run) {
    const concurrent = await priorRun(db, idempotencyKey);
    const concurrentReplay = concurrent ? catalogReplay(concurrent) : null;
    if (concurrentReplay) return concurrentReplay;
    throw new Error("相同简道云目录信封正在并发处理");
  }
  try {
    await finishRun(db, {
      runId: run.id,
      stream: CATALOG_STREAM,
      cursor: evidence.hash,
      sourceRows: forms,
      stagedRows: 0,
      requestScope: { apps: apps.length, forms, authority: "metadata-only" },
    });
    return {
      runId: run.id,
      apps: apps.length,
      forms,
      evidenceHash: evidence.hash,
      replayed: false,
    };
  } catch (error) {
    await failRun(db, run.id, error);
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

function widgetMap(widgets: JiandaoyunWidget[]): Map<string, JiandaoyunWidget> {
  return new Map(widgets.map((widget) => [widget.name, widget]));
}

function contractWidgets(
  contract: JiandaoyunFormContract,
  widgets: JiandaoyunWidget[],
): JiandaoyunWidget[] {
  const top = widgetMap(widgets);
  const missing = contract.fields
    .filter((rule) => !top.has(rule.source))
    .map((rule) => rule.source);
  for (const subform of contract.subforms ?? []) {
    const widget = top.get(subform.source);
    if (!widget || widget.type !== "subform") {
      missing.push(subform.source);
      continue;
    }
    const children = widgetMap(widget.items);
    missing.push(...subform.items.filter((rule) => !children.has(rule.source)).map((rule) =>
      `${subform.source}.${rule.source}`));
  }
  if (missing.length > 0) {
    throw new Error(`简道云字段契约漂移，缺少 ${missing.join(", ")}`);
  }
  return [
    ...contract.fields.map((rule) => top.get(rule.source)!),
    ...(contract.subforms ?? []).map((rule) => {
      const widget = top.get(rule.source)!;
      const children = widgetMap(widget.items);
      return {
        ...widget,
        items: rule.items.map((item) => children.get(item.source)!),
      };
    }),
  ];
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

function sourceAsOf(records: JiandaoyunRecord[]): string | null {
  const latest = records.reduce<number | null>((maximum, record) => {
    const instant = Date.parse(String(record.updateTime ?? record.update_time ?? "").trim());
    if (!Number.isFinite(instant)) return maximum;
    return maximum === null ? instant : Math.max(maximum, instant);
  }, null);
  return latest === null ? null : new Date(latest).toISOString().slice(0, 10);
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
    aliasType: "sku_code" | "warehouse" | "supplier_oem",
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
    });
    if (targetId === null) unresolved.push(`${path}=${value}`);
    return targetId;
  };

  const skuId = await resolve("sku_code", data.productCode, "productCode");
  if (skuId !== null) resolved.skuId = skuId;
  const supplierId = await resolve(
    "supplier_oem",
    data.supplierCode ?? data.supplierName,
    data.supplierCode ? "supplierCode" : "supplierName",
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
  const schemaHash = jiandaoyunSchemaHash(contractWidgets(input.contract, widgets));
  await assertStableContractSchema(db, input.contract.key, schemaHash);
  const records = await input.client.listRecords(input.contract.appId, input.contract.entryId);
  const minimized = records
    .map((record) => minimizeRecord(record, input.contract))
    .sort((left, right) =>
      String(left.sourceRecordId).localeCompare(String(right.sourceRecordId), "en"));
  const asOf = sourceAsOf(records);
  const stream = input.contract.key;
  const envelope = {
    contract: RECORD_SCHEMA_VERSION,
    connector: CONNECTOR,
    stream,
    scope: {
      appId: input.contract.appId,
      entryId: input.contract.entryId,
      schemaHash,
      completeness: "full-authorized-form-view",
      authority: "observation-only",
      fieldMinimized: true,
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
  if (existing) throw new Error("相同简道云表单信封正在处理或先前失败，请检查运行史");
  const run = await insertRun(db, {
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
      authority: "observation-only",
    },
    evidencePath: evidence.relativePath,
    evidenceHash: evidence.hash,
    sourceRows: minimized.length,
  });
  if (!run) {
    const concurrent = await priorRun(db, idempotencyKey);
    const concurrentReplay = concurrent ? formReplay(concurrent, input.contract) : null;
    if (concurrentReplay) return concurrentReplay;
    throw new Error("相同简道云表单信封正在并发处理");
  }

  let importJobId: number | null = null;
  try {
    const job = await createSourceImportJob(db, {
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
        schemaHash,
        mode: "full",
        authority: "observation-only",
        releaseBlocked: true,
        evidencePath: evidence.relativePath,
        evidenceHash: evidence.hash,
      },
    });
    importJobId = job.id;
    const staged: StagingRowInput[] = [];
    let unresolvedAliases = 0;
    for (let index = 0; index < minimized.length; index++) {
      const record = minimized[index];
      const identity = await resolveObservationIdentities(db, input.contract, record);
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
    if (staged.length > 0) await writeStagingRows(db, job.id, staged);
    await finalizeImportJob(db, job.id, {
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
      authority: "observation-only",
      releaseBlocked: true,
      emptySource: minimized.length === 0,
      unresolvedAliases,
    };
    await finishRun(db, {
      runId: run.id,
      stream,
      cursor: evidence.hash,
      importJobId: job.id,
      sourceRows: minimized.length,
      stagedRows: staged.length,
      requestScope,
    });
    return {
      runId: run.id,
      importJobId: job.id,
      contractKey: input.contract.key,
      sourceRows: minimized.length,
      stagedRows: staged.length,
      schemaHash,
      sourceAsOf: asOf,
      unresolvedAliases,
      replayed: false,
    };
  } catch (error) {
    if (importJobId !== null) {
      const [job]: { status: string }[] = await db
        .select({ status: importJobs.status })
        .from(importJobs)
        .where(eq(importJobs.id, importJobId));
      if (job?.status === "validating") {
        await failImportJob(db, importJobId, input.contract.targetTable, error).catch(() => undefined);
      }
    }
    await failRun(db, run.id, error, importJobId);
    throw error;
  }
}
