import { desc, eq, like, sql } from "drizzle-orm";
import {
  importJobs,
  integrationCheckpoints,
  integrationRuns,
  users,
} from "@/db/schema";
import { dAdd, dCmp, dQty } from "@/server/core/decimal";
import {
  createSourceImportJob,
  failImportJob,
  finalizeImportJob,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "@/server/import/staging";
import { resolveOrQueue, type DimDb } from "@/server/modules/dimension/resolver";
import { writeIntegrationEvidence, type IntegrationEvidence } from "./evidence";
import { JstClient, type JstOutboundOrder } from "./jst";

const CONNECTOR = "jst";
const STREAM = "outbound-sales-daily";
const TARGET_TABLE = "jst_daily_sales";
const SCHEMA_VERSION = "jst-outbound-sales-v1";
const SHIPPED_STATUS = new Set(["Confirmed", "Archive"]);

export interface JstDailySyncSummary {
  runId: number;
  importJobId: number;
  bizDate: string;
  sourceOrders: number;
  sourceItems: number;
  stagedRows: number;
  rejectedRows: number;
  unresolvedAliases: number;
  cursorEnd: string;
  replayed: boolean;
}

interface DailyAggregate {
  skuCode: string;
  warehouseRaw: string | null;
  qty: string;
  orderIds: Set<string>;
}

function sourceEnvelope(bizDate: string, orders: JstOutboundOrder[]): unknown {
  return {
    contract: SCHEMA_VERSION,
    connector: CONNECTOR,
    stream: STREAM,
    scope: { bizDate, dateType: "io_date", completeness: "full-day-snapshot" },
    orders: [...orders]
      .sort((left, right) => left.ioId.localeCompare(right.ioId, "en"))
      .map((order) => ({
        ioId: order.ioId,
        orderId: order.orderId,
        salesOrderId: order.salesOrderId,
        shopId: order.shopId,
        warehouseCode: order.warehouseCode,
        status: order.status,
        ioDate: order.ioDate,
        modifiedAt: order.modifiedAt,
        cursor: order.cursor,
        items: [...order.items].sort((left, right) =>
          `${left.lineId ?? ""}\0${left.skuCode}`.localeCompare(
            `${right.lineId ?? ""}\0${right.skuCode}`,
            "en",
          )),
      })),
  };
}

function cursorMax(orders: JstOutboundOrder[]): string {
  return orders.reduce(
    (max, order) => BigInt(order.cursor) > BigInt(max) ? order.cursor : max,
    "1",
  );
}

function aggregateDaily(
  bizDate: string,
  orders: JstOutboundOrder[],
): { rows: DailyAggregate[]; rejects: StagingRowInput[]; sourceItems: number } {
  const aggregates = new Map<string, DailyAggregate>();
  const rejects: StagingRowInput[] = [];
  let rowNo = 0;
  let sourceItems = 0;
  for (const order of orders) {
    for (const item of order.items) {
      sourceItems++;
      rowNo++;
      if (!order.ioDate.startsWith(bizDate)) {
        rejects.push({
          rowNo,
          targetTable: TARGET_TABLE,
          payload: { ioId: order.ioId, ioDate: order.ioDate, skuCode: item.skuCode },
          status: "error",
          errorMsg: `出库日期不在请求日 ${bizDate}`,
        });
        continue;
      }
      if (!SHIPPED_STATUS.has(order.status)) continue;
      if (dCmp(item.qty, "0") < 0) {
        rejects.push({
          rowNo,
          targetTable: TARGET_TABLE,
          payload: { ioId: order.ioId, skuCode: item.skuCode, qty: item.qty },
          status: "error",
          errorMsg: "已出库明细数量为负，需人工核对退货/冲销口径",
        });
        continue;
      }
      const key = `${item.skuCode}\0${order.warehouseCode ?? ""}`;
      const aggregate = aggregates.get(key) ?? {
        skuCode: item.skuCode,
        warehouseRaw: order.warehouseCode,
        qty: "0.0000",
        orderIds: new Set<string>(),
      };
      aggregate.qty = dAdd(aggregate.qty, item.qty, 4);
      aggregate.orderIds.add(order.ioId);
      aggregates.set(key, aggregate);
    }
  }
  return {
    rows: [...aggregates.values()].sort((left, right) =>
      `${left.skuCode}\0${left.warehouseRaw ?? ""}`.localeCompare(
        `${right.skuCode}\0${right.warehouseRaw ?? ""}`,
        "en",
      )),
    rejects,
    sourceItems,
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

interface PriorRun {
  id: number;
  status: string;
  importJobId: number | null;
  requestScope: unknown;
  sourceRows: number;
  stagedRows: number;
  rejectedRows: number;
  cursorEnd: string | null;
}

function summaryFromRun(run: PriorRun): JstDailySyncSummary | null {
  if (run.status !== "succeeded" || !run.importJobId || !run.cursorEnd) return null;
  const scope = run.requestScope as { bizDate?: unknown; sourceOrders?: unknown; unresolvedAliases?: unknown } | null;
  return {
    runId: run.id,
    importJobId: run.importJobId,
    bizDate: typeof scope?.bizDate === "string" ? scope.bizDate : "",
    sourceOrders: Number(scope?.sourceOrders ?? 0),
    sourceItems: run.sourceRows,
    stagedRows: run.stagedRows,
    rejectedRows: run.rejectedRows,
    unresolvedAliases: Number(scope?.unresolvedAliases ?? 0),
    cursorEnd: run.cursorEnd,
    replayed: true,
  };
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
      rejectedRows: integrationRuns.rejectedRows,
      cursorEnd: integrationRuns.cursorEnd,
    })
    .from(integrationRuns)
    .where(like(integrationRuns.idempotencyKey, `${baseIdempotencyKey}%`))
    .orderBy(desc(integrationRuns.id));
}

export async function syncJstDailySales(
  db: AnyDb,
  input: {
    client: JstClient;
    bizDate: string;
    actorId: number;
    writeEvidence?: (
      connector: string,
      stream: string,
      envelope: unknown,
    ) => Promise<IntegrationEvidence>;
  },
): Promise<JstDailySyncSummary> {
  await assertActor(db, input.actorId);
  const orders = await input.client.fetchOutboundOrdersForDay(input.bizDate);
  const evidence = await (input.writeEvidence ?? writeIntegrationEvidence)(
    CONNECTOR,
    STREAM,
    sourceEnvelope(input.bizDate, orders),
  );
  const baseIdempotencyKey = `${CONNECTOR}:${STREAM}:${input.bizDate}:${evidence.hash}`;
  const priorRuns = await priorRunsForSource(db, baseIdempotencyKey);
  const replay = priorRuns.map(summaryFromRun).find((summary) => summary !== null) ?? null;
  if (replay) return replay;
  if (priorRuns.some((run) => run.status === "running")) {
    throw new Error("相同聚水潭源信封正在处理，请等待当前运行完成");
  }
  const idempotencyKey = priorRuns.length === 0
    ? baseIdempotencyKey
    : `${baseIdempotencyKey}:retry:${priorRuns.length}`;

  const cursorEnd = cursorMax(orders);
  const { rows, rejects, sourceItems } = aggregateDaily(input.bizDate, orders);
  const [run]: { id: number }[] = await db.insert(integrationRuns).values({
    connector: CONNECTOR,
    stream: STREAM,
    idempotencyKey,
    cursorStart: "1",
    cursorEnd,
    requestScope: {
      bizDate: input.bizDate,
      sourceOrders: orders.length,
      mode: "full-day-snapshot",
    },
    evidencePath: evidence.relativePath,
    evidenceHash: evidence.hash,
    sourceRows: sourceItems,
  }).onConflictDoNothing().returning({ id: integrationRuns.id });
  if (!run) {
    const concurrentRuns = await priorRunsForSource(db, baseIdempotencyKey);
    const concurrentReplay = concurrentRuns
      .map(summaryFromRun)
      .find((summary) => summary !== null) ?? null;
    if (concurrentReplay) return concurrentReplay;
    throw new Error("相同聚水潭源信封正在并发处理，请等待当前运行完成");
  }

  let importJobId: number | null = null;
  try {
    const job = await createSourceImportJob(db, {
      template: TARGET_TABLE,
      sourceName: `${CONNECTOR}-${STREAM}-${input.bizDate}-${evidence.hash.slice(0, 12)}.json`,
      sourceBytes: evidence.bytes,
      createdBy: input.actorId,
      idempotencyKey: `${TARGET_TABLE}:${input.bizDate}`,
      sourceAsOf: input.bizDate,
      schemaVersion: SCHEMA_VERSION,
      scope: {
        connector: CONNECTOR,
        stream: STREAM,
        mode: "full",
        bizDate: input.bizDate,
        evidencePath: evidence.relativePath,
        evidenceHash: evidence.hash,
      },
    });
    importJobId = job.id;
    const staged: StagingRowInput[] = [];
    let unresolvedAliases = 0;
    let rowNo = 0;
    for (const row of rows) {
      rowNo++;
      const skuId = await resolveOrQueue(db as DimDb, "sku_code", row.skuCode, {
        connector: CONNECTOR,
        stream: STREAM,
        bizDate: input.bizDate,
        field: "sku",
      });
      const warehouseId = row.warehouseRaw
        ? await resolveOrQueue(db as DimDb, "warehouse", row.warehouseRaw, {
            connector: CONNECTOR,
            stream: STREAM,
            bizDate: input.bizDate,
            field: "warehouse",
          })
        : null;
      const misses = [
        skuId === null ? `sku=${row.skuCode}` : null,
        row.warehouseRaw && warehouseId === null ? `warehouse=${row.warehouseRaw}` : null,
      ].filter((value): value is string => value !== null);
      unresolvedAliases += misses.length;
      staged.push({
        rowNo,
        targetTable: TARGET_TABLE,
        payload: {
          bizDate: input.bizDate,
          skuCode: row.skuCode,
          warehouseRaw: row.warehouseRaw,
          qty: dQty(row.qty),
          source: "jst_api",
          sourceOrderCount: row.orderIds.size,
          _resolved: {
            ...(skuId === null ? {} : { skuId }),
            ...(warehouseId === null ? {} : { warehouseId }),
          },
        },
        status: misses.length === 0 ? "validated" : "pending",
        errorMsg: misses.length === 0 ? null : `未解析别名: ${misses.join("; ")}`,
      });
    }
    staged.push(...rejects.map((row, index) => ({ ...row, rowNo: rowNo + index + 1 })));
    if (staged.length > 0) await writeStagingRows(db, job.id, staged);
    await finalizeImportJob(db, job.id, {
      okRows: rows.length,
      failRows: rejects.length,
      controlRows: rows.length + rejects.length,
    });

    const finishedAt = new Date();
    await db.transaction(async (tx: AnyDb) => {
      await tx.update(integrationRuns).set({
        status: "succeeded",
        importJobId: job.id,
        stagedRows: rows.length,
        rejectedRows: rejects.length,
        requestScope: {
          bizDate: input.bizDate,
          sourceOrders: orders.length,
          unresolvedAliases,
          mode: "full-day-snapshot",
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
      bizDate: input.bizDate,
      sourceOrders: orders.length,
      sourceItems,
      stagedRows: rows.length,
      rejectedRows: rejects.length,
      unresolvedAliases,
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
    const message = error instanceof Error ? error.message : String(error);
    await db.update(integrationRuns).set({
      status: "failed",
      importJobId,
      error: message.slice(0, 500),
      finishedAt: new Date(),
    }).where(eq(integrationRuns.id, run.id));
    throw error;
  }
}

export function jstSyncActorId(env: NodeJS.ProcessEnv = process.env): number | null {
  const actorId = Number(env.JST_SYNC_ACTOR_ID);
  return Number.isInteger(actorId) && actorId > 0 ? actorId : null;
}
