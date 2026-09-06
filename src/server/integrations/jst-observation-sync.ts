/**
 * Two additional JST read-only observations with verified official contracts:
 * - item master: /open/sku/query
 * - purchase receipts: /open/purchasein/query
 *
 * Both stop at protected evidence + governed staging. They never create/update SKU masters,
 * receive stock, post ledgers, or turn an external observation into an operational fact.
 */
import { desc, eq, like, sql } from "drizzle-orm";
import { storedErrorDiagnostic } from "@/server/core/logger";
import {
  integrationCheckpoints,
  integrationRuns,
  users,
} from "@/db/schema";
import {
  createSourceImportJobInTransaction,
  finalizeImportJob,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "@/server/import/staging";
import { resolveKnownOrQueue, type DimDb } from "@/server/modules/dimension/resolver";
import {
  type JstInboundReceipt,
  type JstItemMasterRow,
} from "./jst";
import { writeIntegrationEvidence, type IntegrationEvidence } from "./evidence";

const CONNECTOR = "jst";

export const JST_GOVERNED_OBSERVATION_CONTRACTS = {
  "item-master": {
    schemaVersion: "jst-item-master-observation-v1",
    targetTable: "jst_item_master_observation",
    officialPath: "/open/sku/query",
    coverage: "modified-item-identity-and-lifecycle",
  },
  "inbound-receipts-daily": {
    schemaVersion: "jst-inbound-receipts-observation-v1",
    targetTable: "jst_inbound_receipts_observation",
    officialPath: "/open/purchasein/query",
    coverage: "receipts-changed-in-business-day",
  },
} as const;

export type JstGovernedObservationContract = keyof typeof JST_GOVERNED_OBSERVATION_CONTRACTS;

export function configuredJstGovernedObservationContracts(
  env: NodeJS.ProcessEnv = process.env,
): JstGovernedObservationContract[] {
  const raw = env.JST_OBSERVATION_SYNC_CONTRACTS?.trim() ?? "";
  if (!raw) return [];
  const known = new Set(Object.keys(JST_GOVERNED_OBSERVATION_CONTRACTS));
  const contracts = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  const invalid = contracts.filter((value) => !known.has(value));
  if (invalid.length > 0) {
    throw new Error(`JST_OBSERVATION_SYNC_CONTRACTS 含未知契约: ${invalid.join(", ")}`);
  }
  return contracts as JstGovernedObservationContract[];
}

export interface JstObservationClient {
  fetchItemsModified(modifiedBegin: string, modifiedEnd: string): Promise<JstItemMasterRow[]>;
  fetchInboundReceiptsModified(
    modifiedBegin: string,
    modifiedEnd: string,
  ): Promise<JstInboundReceipt[]>;
}

export interface JstGovernedObservationSummary {
  runId: number;
  importJobId: number;
  contract: JstGovernedObservationContract;
  sourceAsOf: string;
  sourceRows: number;
  stagedRows: number;
  unresolvedAliases: number;
  evidenceHash: string;
  replayed: boolean;
  releaseBlocked: true;
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

function validBusinessDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function dayWindow(sourceAsOf: string): { modifiedBegin: string; modifiedEnd: string } {
  if (!validBusinessDay(sourceAsOf)) {
    throw new Error("聚水潭观察 sourceAsOf 必须是有效的 YYYY-MM-DD 业务日期");
  }
  return {
    modifiedBegin: `${sourceAsOf} 00:00:00`,
    modifiedEnd: `${sourceAsOf} 23:59:59`,
  };
}

function scopeObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function assertActor(db: AnyDb, actorId: number): Promise<void> {
  const [actor]: { id: number; active: boolean }[] = await db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  if (!actor?.active) throw new Error("JST_SYNC_ACTOR_ID 未指向有效启用用户");
}

async function priorRunsForSource(db: AnyDb, baseKey: string): Promise<PriorRun[]> {
  return db
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
    .where(like(integrationRuns.idempotencyKey, `${baseKey}%`))
    .orderBy(desc(integrationRuns.id));
}

function summaryFromRun(
  run: PriorRun,
  contract: JstGovernedObservationContract,
): JstGovernedObservationSummary | null {
  if (run.status !== "succeeded" || run.importJobId === null) return null;
  const scope = scopeObject(run.requestScope);
  return {
    runId: run.id,
    importJobId: run.importJobId,
    contract,
    sourceAsOf: typeof scope.sourceAsOf === "string" ? scope.sourceAsOf : "",
    sourceRows: run.sourceRows,
    stagedRows: run.stagedRows,
    unresolvedAliases: Number(scope.unresolvedAliases ?? 0),
    evidenceHash: run.evidenceHash ?? "",
    replayed: true,
    releaseBlocked: true,
  };
}

function sourceEnvelope(
  contract: JstGovernedObservationContract,
  sourceAsOf: string,
  modifiedBegin: string,
  modifiedEnd: string,
  rows: JstItemMasterRow[] | JstInboundReceipt[],
): unknown {
  const meta = JST_GOVERNED_OBSERVATION_CONTRACTS[contract];
  const ordered = contract === "item-master"
    ? [...rows as JstItemMasterRow[]].sort((a, b) => a.skuCode.localeCompare(b.skuCode, "en"))
    : [...rows as JstInboundReceipt[]]
        .map((receipt) => ({
          ...receipt,
          items: [...receipt.items].sort((a, b) =>
            `${a.lineId ?? ""}\0${a.skuCode}`.localeCompare(`${b.lineId ?? ""}\0${b.skuCode}`, "en")),
          batches: [...receipt.batches].sort((a, b) =>
            `${a.lineId ?? ""}\0${a.skuCode}\0${a.batchNo ?? ""}`.localeCompare(
              `${b.lineId ?? ""}\0${b.skuCode}\0${b.batchNo ?? ""}`,
              "en",
            )),
        }))
        .sort((a, b) => a.receiptId.localeCompare(b.receiptId, "en"));
  return {
    contract: meta.schemaVersion,
    connector: CONNECTOR,
    stream: contract,
    scope: {
      sourceAsOf,
      modifiedBegin,
      modifiedEnd,
      officialPath: meta.officialPath,
      coverage: meta.coverage,
      authority: "observation-only",
      releaseBlocked: true,
    },
    rows: ordered,
  };
}

async function itemStagingRows(
  tx: AnyDb,
  rows: JstItemMasterRow[],
  sourceAsOf: string,
): Promise<{ rows: StagingRowInput[]; unresolvedAliases: number }> {
  const staged: StagingRowInput[] = [];
  let unresolvedAliases = 0;
  for (const [index, row] of rows.entries()) {
    const skuId = await resolveKnownOrQueue(dbAsDim(tx), "sku_code", row.skuCode, {
      connector: CONNECTOR,
      stream: "item-master",
      sourceAsOf,
      field: "sku",
    }, { scope: "JST" });
    if (skuId === null) unresolvedAliases++;
    staged.push({
      rowNo: index + 1,
      targetTable: JST_GOVERNED_OBSERVATION_CONTRACTS["item-master"].targetTable,
      payload: {
        ...row,
        source: "jst_api",
        sourceAsOf,
        _resolved: skuId === null ? {} : { skuId },
      },
      status: skuId === null ? "pending" : "validated",
      errorMsg: skuId === null ? `未解析别名: sku=${row.skuCode}` : null,
    });
  }
  return { rows: staged, unresolvedAliases };
}

function dbAsDim(db: AnyDb): DimDb {
  return db as DimDb;
}

async function receiptStagingRows(
  tx: AnyDb,
  receipts: JstInboundReceipt[],
  sourceAsOf: string,
): Promise<{ rows: StagingRowInput[]; unresolvedAliases: number }> {
  const staged: StagingRowInput[] = [];
  let unresolvedAliases = 0;
  for (const [index, receipt] of receipts.entries()) {
    const warehouseId = receipt.warehouseCode
      ? await resolveKnownOrQueue(dbAsDim(tx), "warehouse", receipt.warehouseCode, {
          connector: CONNECTOR,
          stream: "inbound-receipts-daily",
          sourceAsOf,
          field: "warehouse",
        }, { scope: "JST" })
      : null;
    const resolvedSkuIds: Record<string, number> = {};
    const uniqueSkuCodes = [...new Set([
      ...receipt.items.map((item) => item.skuCode),
      ...receipt.batches.map((batch) => batch.skuCode),
    ])].sort((a, b) => a.localeCompare(b, "en"));
    for (const skuCode of uniqueSkuCodes) {
      const skuId = await resolveKnownOrQueue(dbAsDim(tx), "sku_code", skuCode, {
        connector: CONNECTOR,
        stream: "inbound-receipts-daily",
        sourceAsOf,
        field: "sku",
      }, { scope: "JST" });
      if (skuId === null) unresolvedAliases++;
      else resolvedSkuIds[skuCode] = skuId;
    }
    if (receipt.warehouseCode && warehouseId === null) unresolvedAliases++;
    const misses = uniqueSkuCodes.filter((skuCode) => resolvedSkuIds[skuCode] === undefined);
    if (receipt.warehouseCode && warehouseId === null) misses.push(`warehouse:${receipt.warehouseCode}`);
    staged.push({
      rowNo: index + 1,
      targetTable: JST_GOVERNED_OBSERVATION_CONTRACTS["inbound-receipts-daily"].targetTable,
      payload: {
        ...receipt,
        source: "jst_api",
        sourceAsOf,
        _resolved: {
          ...(warehouseId === null ? {} : { warehouseId }),
          skuIds: resolvedSkuIds,
        },
      },
      status: misses.length === 0 ? "validated" : "pending",
      errorMsg: misses.length === 0 ? null : `未解析别名: ${misses.join("; ")}`,
    });
  }
  return { rows: staged, unresolvedAliases };
}

export async function syncJstGovernedObservation(
  db: AnyDb,
  input: {
    client: JstObservationClient;
    contract: JstGovernedObservationContract;
    sourceAsOf: string;
    actorId: number;
    writeEvidence?: (
      connector: string,
      stream: string,
      envelope: unknown,
    ) => Promise<IntegrationEvidence>;
  },
): Promise<JstGovernedObservationSummary> {
  await assertActor(db, input.actorId);
  const { modifiedBegin, modifiedEnd } = dayWindow(input.sourceAsOf);
  const rows = input.contract === "item-master"
    ? await input.client.fetchItemsModified(modifiedBegin, modifiedEnd)
    : await input.client.fetchInboundReceiptsModified(modifiedBegin, modifiedEnd);
  const evidence = await (input.writeEvidence ?? writeIntegrationEvidence)(
    CONNECTOR,
    input.contract,
    sourceEnvelope(input.contract, input.sourceAsOf, modifiedBegin, modifiedEnd, rows),
  );
  const baseKey = `${CONNECTOR}:${input.contract}:${input.sourceAsOf}:${evidence.hash}`;
  const priorRuns = await priorRunsForSource(db, baseKey);
  const replay = priorRuns
    .map((run) => summaryFromRun(run, input.contract))
    .find((summary) => summary !== null) ?? null;
  if (replay) return replay;
  if (priorRuns.some((run) => run.status === "running")) {
    throw new Error("相同聚水潭观察信封正在处理，请等待当前运行完成");
  }
  const idempotencyKey = priorRuns.length === 0
    ? baseKey
    : `${baseKey}:retry:${priorRuns.length}`;
  const meta = JST_GOVERNED_OBSERVATION_CONTRACTS[input.contract];
  const [run]: { id: number }[] = await db.insert(integrationRuns).values({
    connector: CONNECTOR,
    stream: input.contract,
    idempotencyKey,
    requestScope: {
      sourceAsOf: input.sourceAsOf,
      modifiedBegin,
      modifiedEnd,
      coverage: meta.coverage,
      authority: "observation-only",
      releaseBlocked: true,
    },
    evidencePath: evidence.relativePath,
    evidenceHash: evidence.hash,
    sourceRows: rows.length,
  }).onConflictDoNothing().returning({ id: integrationRuns.id });
  if (!run) throw new Error("相同聚水潭观察信封正在并发处理，请等待当前运行完成");

  try {
    return await db.transaction(async (tx: AnyDb) => {
      const staged = input.contract === "item-master"
        ? await itemStagingRows(tx, rows as JstItemMasterRow[], input.sourceAsOf)
        : await receiptStagingRows(tx, rows as JstInboundReceipt[], input.sourceAsOf);
      const job = await createSourceImportJobInTransaction(tx, {
        template: meta.targetTable,
        sourceName: `${CONNECTOR}-${input.contract}-${input.sourceAsOf}-${evidence.hash.slice(0, 12)}.json`,
        sourceBytes: evidence.bytes,
        createdBy: input.actorId,
        idempotencyKey: `${meta.targetTable}:${input.sourceAsOf}`,
        sourceAsOf: input.sourceAsOf,
        schemaVersion: meta.schemaVersion,
        scope: {
          connector: CONNECTOR,
          stream: input.contract,
          mode: "full",
          authority: "observation-only",
          releaseBlocked: true,
          coverage: meta.coverage,
          officialPath: meta.officialPath,
          evidencePath: evidence.relativePath,
          evidenceHash: evidence.hash,
        },
      });
      if (staged.rows.length > 0) await writeStagingRows(tx, job.id, staged.rows);
      await finalizeImportJob(tx, job.id, {
        okRows: staged.rows.length,
        failRows: 0,
        controlRows: rows.length,
      });
      const finishedAt = new Date();
      await tx.update(integrationRuns).set({
        status: "succeeded",
        importJobId: job.id,
        stagedRows: staged.rows.length,
        rejectedRows: 0,
        requestScope: {
          sourceAsOf: input.sourceAsOf,
          modifiedBegin,
          modifiedEnd,
          coverage: meta.coverage,
          authority: "observation-only",
          releaseBlocked: true,
          unresolvedAliases: staged.unresolvedAliases,
        },
        finishedAt,
      }).where(eq(integrationRuns.id, run.id));
      await tx.insert(integrationCheckpoints).values({
        connector: CONNECTOR,
        stream: input.contract,
        cursor: input.sourceAsOf,
        lastRunId: run.id,
        lastSuccessAt: finishedAt,
        updatedAt: finishedAt,
      }).onConflictDoUpdate({
        target: [integrationCheckpoints.connector, integrationCheckpoints.stream],
        set: {
          cursor: input.sourceAsOf,
          version: sql`${integrationCheckpoints.version} + 1`,
          lastRunId: run.id,
          lastSuccessAt: finishedAt,
          updatedAt: finishedAt,
        },
      });
      return {
        runId: run.id,
        importJobId: job.id,
        contract: input.contract,
        sourceAsOf: input.sourceAsOf,
        sourceRows: rows.length,
        stagedRows: staged.rows.length,
        unresolvedAliases: staged.unresolvedAliases,
        evidenceHash: evidence.hash,
        replayed: false,
        releaseBlocked: true,
      };
    });
  } catch (error) {
    await db.update(integrationRuns).set({
      status: "failed",
      error: storedErrorDiagnostic(error).slice(0, 500),
      finishedAt: new Date(),
    }).where(eq(integrationRuns.id, run.id));
    throw error;
  }
}
