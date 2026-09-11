import { and, desc, eq, like, sql } from "drizzle-orm";
import { storedErrorDiagnostic } from "@/server/core/logger";
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
import { writeIntegrationEvidence, type IntegrationEvidence } from "./evidence";
import { JstClient, type JstInventoryRow } from "./jst";
import {
  inventoryStreamBlockReason,
  jstWarehouseTrustFromEnv,
} from "./jst-warehouse-trust";
import { shanghaiDayOf } from "@/server/core/business-day";

const CONNECTOR = "jst";
const STREAM = "inventory-total-delta";
const TARGET_TABLE = "jst_inventory_observation";
const SCHEMA_VERSION = "jst-inventory-observation-v1";
const GRAIN = "sku-all-jst-warehouses";

export interface JstInventorySyncSummary {
  runId: number;
  importJobId: number;
  observedAt: string;
  sourceRows: number;
  stagedRows: number;
  unresolvedAliases: number;
  cursorStart: string;
  cursorEnd: string;
  replayed: boolean;
}

interface PriorRun {
  id: number;
  status: string;
  importJobId: number | null;
  requestScope: unknown;
  sourceRows: number;
  stagedRows: number;
  cursorStart: string | null;
  cursorEnd: string | null;
}

const shanghaiDate = shanghaiDayOf;

function cursorMax(rows: JstInventoryRow[], start: string): string {
  return rows.reduce(
    (max, row) => BigInt(row.cursor) > BigInt(max) ? row.cursor : max,
    start,
  );
}

function sourceEnvelope(
  observedAt: string,
  cursorStart: string,
  cursorEnd: string,
  rows: JstInventoryRow[],
): unknown {
  return {
    contract: SCHEMA_VERSION,
    connector: CONNECTOR,
    stream: STREAM,
    scope: {
      grain: GRAIN,
      mode: "delta",
      completeness: "changed-since-cursor",
      observedAt,
      cursorStart,
      cursorEnd,
    },
    rows: [...rows].sort((left, right) =>
      `${left.skuCode}\0${left.cursor}`.localeCompare(
        `${right.skuCode}\0${right.cursor}`,
        "en",
      )),
  };
}

async function assertActor(db: AnyDb, actorId: number): Promise<void> {
  const [actor]: { id: number; active: boolean }[] = await db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  if (!actor?.active) throw new Error("JST_SYNC_ACTOR_ID 未指向有效启用用户");
}

async function priorRunsForSource(
  db: AnyDb,
  baseIdempotencyKey: string,
): Promise<PriorRun[]> {
  return db
    .select({
      id: integrationRuns.id,
      status: integrationRuns.status,
      importJobId: integrationRuns.importJobId,
      requestScope: integrationRuns.requestScope,
      sourceRows: integrationRuns.sourceRows,
      stagedRows: integrationRuns.stagedRows,
      cursorStart: integrationRuns.cursorStart,
      cursorEnd: integrationRuns.cursorEnd,
    })
    .from(integrationRuns)
    .where(like(integrationRuns.idempotencyKey, `${baseIdempotencyKey}%`))
    .orderBy(desc(integrationRuns.id));
}

function summaryFromRun(run: PriorRun): JstInventorySyncSummary | null {
  if (
    run.status !== "succeeded"
    || !run.importJobId
    || run.cursorStart === null
    || run.cursorEnd === null
  ) return null;
  const scope = run.requestScope as {
    observedAt?: unknown;
    unresolvedAliases?: unknown;
  } | null;
  return {
    runId: run.id,
    importJobId: run.importJobId,
    observedAt: typeof scope?.observedAt === "string" ? scope.observedAt : "",
    sourceRows: run.sourceRows,
    stagedRows: run.stagedRows,
    unresolvedAliases: Number(scope?.unresolvedAliases ?? 0),
    cursorStart: run.cursorStart,
    cursorEnd: run.cursorEnd,
    replayed: true,
  };
}

/**
 * Pulls changed JST inventory totals into governed staging.
 *
 * This stream deliberately does not write stock_snapshots: the official endpoint requires a
 * cursor/time/SKU filter and, without wms_co_id, returns an all-warehouse total. Missing rows are
 * therefore unknown—not zero—and cannot safely replace warehouse-grain stock truth.
 */
export async function syncJstInventoryObservations(
  db: AnyDb,
  input: {
    client: JstClient;
    actorId: number;
    observedAt?: Date;
    writeEvidence?: (
      connector: string,
      stream: string,
      envelope: unknown,
    ) => Promise<IntegrationEvidence>;
  },
): Promise<JstInventorySyncSummary> {
  await assertActor(db, input.actorId);
  const observedAtDate = input.observedAt ?? new Date();
  const observedAt = observedAtDate.toISOString();
  const [checkpoint]: { cursor: string }[] = await db
    .select({ cursor: integrationCheckpoints.cursor })
    .from(integrationCheckpoints)
    .where(and(
      eq(integrationCheckpoints.connector, CONNECTOR),
      eq(integrationCheckpoints.stream, STREAM),
    ))
    .limit(1);
  const cursorStart = checkpoint?.cursor ?? "1";
  const rows = await input.client.fetchInventoryChanged({
    startCursor: cursorStart,
    includeLockQty: true,
  });
  const cursorEnd = cursorMax(rows, cursorStart);
  const evidence = await (input.writeEvidence ?? writeIntegrationEvidence)(
    CONNECTOR,
    STREAM,
    sourceEnvelope(observedAt, cursorStart, cursorEnd, rows),
  );
  const baseIdempotencyKey = `${CONNECTOR}:${STREAM}:${cursorStart}:${evidence.hash}`;
  const priorRuns = await priorRunsForSource(db, baseIdempotencyKey);
  const replay = priorRuns.map(summaryFromRun).find((summary) => summary !== null) ?? null;
  if (replay) return replay;
  if (priorRuns.some((run) => run.status === "running")) {
    throw new Error("相同聚水潭库存源信封正在处理，请等待当前运行完成");
  }
  const idempotencyKey = priorRuns.length === 0
    ? baseIdempotencyKey
    : `${baseIdempotencyKey}:retry:${priorRuns.length}`;

  const [run]: { id: number }[] = await db.insert(integrationRuns).values({
    connector: CONNECTOR,
    stream: STREAM,
    idempotencyKey,
    cursorStart,
    cursorEnd,
    requestScope: {
      observedAt,
      grain: GRAIN,
      mode: "delta",
      completeness: "changed-since-cursor",
    },
    evidencePath: evidence.relativePath,
    evidenceHash: evidence.hash,
    sourceRows: rows.length,
  }).onConflictDoNothing().returning({ id: integrationRuns.id });
  if (!run) {
    const concurrentRuns = await priorRunsForSource(db, baseIdempotencyKey);
    const concurrentReplay = concurrentRuns
      .map(summaryFromRun)
      .find((summary) => summary !== null) ?? null;
    if (concurrentReplay) return concurrentReplay;
    throw new Error("相同聚水潭库存源信封正在并发处理，请等待当前运行完成");
  }

  let importJobId: number | null = null;
  try {
    const job = await createSourceImportJob(db, {
      template: TARGET_TABLE,
      sourceName: `${CONNECTOR}-${STREAM}-${observedAt.slice(0, 19).replaceAll(":", "")}-${evidence.hash.slice(0, 12)}.json`,
      sourceBytes: evidence.bytes,
      createdBy: input.actorId,
      idempotencyKey: `${TARGET_TABLE}:${cursorStart}:${evidence.hash}`,
      sourceAsOf: shanghaiDate(observedAtDate),
      schemaVersion: SCHEMA_VERSION,
      scope: {
        connector: CONNECTOR,
        stream: STREAM,
        grain: GRAIN,
        mode: "delta",
        completeness: "changed-since-cursor",
        observedAt,
        cursorStart,
        cursorEnd,
        evidencePath: evidence.relativePath,
        evidenceHash: evidence.hash,
      },
    });
    importJobId = job.id;
    const staged: StagingRowInput[] = [];
    let unresolvedAliases = 0;
    for (const [index, row] of rows.entries()) {
      const skuId = await resolveKnownOrQueue(db as DimDb, "sku_code", row.skuCode, {
        connector: CONNECTOR,
        stream: STREAM,
        observedAt,
        field: "sku",
      }, { scope: "JST" });
      if (skuId === null) unresolvedAliases++;
      staged.push({
        rowNo: index + 1,
        targetTable: TARGET_TABLE,
        payload: {
          grain: GRAIN,
          source: "jst_api",
          observedAt,
          modifiedAt: row.modifiedAt,
          cursor: row.cursor,
          skuCode: row.skuCode,
          itemId: row.itemId,
          name: row.name,
          qty: row.qty,
          orderLockQty: row.orderLockQty,
          pickLockQty: row.pickLockQty,
          inventoryLockQty: row.inventoryLockQty,
          virtualQty: row.virtualQty,
          purchaseQty: row.purchaseQty,
          returnQty: row.returnQty,
          inboundQty: row.inboundQty,
          transferInboundQty: row.transferInboundQty,
          saleRefundInboundQty: row.saleRefundInboundQty,
          defectiveQty: row.defectiveQty,
          minQty: row.minQty,
          maxQty: row.maxQty,
          _resolved: skuId === null ? {} : { skuId },
        },
        status: skuId === null ? "pending" : "validated",
        errorMsg: skuId === null ? `未解析别名: sku=${row.skuCode}` : null,
      });
    }
    if (staged.length > 0) await writeStagingRows(db, job.id, staged);
    await finalizeImportJob(db, job.id, {
      okRows: rows.length,
      failRows: 0,
      controlRows: rows.length,
    });

    const finishedAt = new Date();
    await db.transaction(async (tx: AnyDb) => {
      await tx.update(integrationRuns).set({
        status: "succeeded",
        importJobId: job.id,
        stagedRows: rows.length,
        requestScope: {
          observedAt,
          grain: GRAIN,
          mode: "delta",
          completeness: "changed-since-cursor",
          unresolvedAliases,
        },
        finishedAt,
      }).where(eq(integrationRuns.id, run.id));
      await tx.insert(integrationCheckpoints).values({
        connector: CONNECTOR,
        stream: STREAM,
        cursor: cursorEnd,
        lastRunId: run.id,
        lastSuccessAt: finishedAt,
        updatedAt: finishedAt,
      }).onConflictDoUpdate({
        target: [integrationCheckpoints.connector, integrationCheckpoints.stream],
        set: {
          cursor: cursorEnd,
          version: sql`${integrationCheckpoints.version} + 1`,
          lastRunId: run.id,
          lastSuccessAt: finishedAt,
          updatedAt: finishedAt,
        },
      });
    });
    return {
      runId: run.id,
      importJobId: job.id,
      observedAt,
      sourceRows: rows.length,
      stagedRows: rows.length,
      unresolvedAliases,
      cursorStart,
      cursorEnd,
      replayed: false,
    };
  } catch (error) {
    if (importJobId !== null) {
      const [job]: { status: string }[] = await db
        .select({ status: importJobs.status })
        .from(importJobs)
        .where(eq(importJobs.id, importJobId));
      if (job && job.status === "validating") {
        await failImportJob(db, importJobId, TARGET_TABLE, error).catch(() => undefined);
      }
    }
    const message = storedErrorDiagnostic(error);
    await db.update(integrationRuns).set({
      status: "failed",
      importJobId,
      error: message.slice(0, 500),
      finishedAt: new Date(),
    }).where(eq(integrationRuns.id, run.id));
    throw error;
  }
}

/**
 * 库存流是否启用。
 *
 * **仅有环境变量为真还不够**：本接口在不带 wms_co_id 时返回的是**全仓合计**。
 * 而业务已明确（2026-08-04）聚水潭只有「一仓」的数据准、其余仓不准——
 * 那个合计把准仓与不准仓加在一起且拆不开，看起来却像一个完整库存总量。
 * 这种数字比没有数字更危险：它会被当成事实引用进补货与对账。
 *
 * 所以这里是**双重闸**：开关为真，且仓库可信范围检查放行，才算启用。
 * 想真正启用，正确做法是改为逐仓拉取，而不是把可信清单删掉绕过检查
 * （删掉只会落到"未声明"分支，同样被拒）。
 */
export function jstInventorySyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flagOn = ["1", "true", "yes"].includes(
    env.JST_INVENTORY_SYNC_ENABLED?.trim().toLowerCase() ?? "",
  );
  if (!flagOn) return false;
  return inventoryStreamBlockReason(jstWarehouseTrustFromEnv(env)) === null;
}

/** 未启用时的具体原因，供运维面板/日志显示，避免只看到一个 false */
export function jstInventorySyncBlockReason(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const flagOn = ["1", "true", "yes"].includes(
    env.JST_INVENTORY_SYNC_ENABLED?.trim().toLowerCase() ?? "",
  );
  if (!flagOn) return "JST_INVENTORY_SYNC_ENABLED 未开启";
  return inventoryStreamBlockReason(jstWarehouseTrustFromEnv(env));
}
