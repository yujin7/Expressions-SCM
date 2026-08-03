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
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { integrationCheckpoints, integrationRuns, users } from "@/db/schema";
import {
  createSourceImportJobInTransaction,
  finalizeImportJob,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "@/server/import/staging";
import { writeIntegrationEvidence } from "./evidence";
import { YonyouApiError, YonyouClient } from "./yonyou-client";
import { yonyouReadContractByName, type YonyouReadContractName } from "./yonyou-contracts";

const CONNECTOR = "yy";
const SCHEMA_VERSION = "yonyou-observation-v1";
/** staging 目标表名：观测层，非业务表。放行阶段才会有人决定它变成什么。 */
const TARGET_TABLE = "yonyou_observation";
const RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1_000;

export interface YonyouSyncSummary {
  runId: number;
  importJobId: number | null;
  contract: string;
  /** 源侧返回的顶层记录数；无法判定时为 0 并在 shapeNote 说明。 */
  sourceRows: number;
  stagedRows: number;
  evidenceHash: string;
  /** 观测到的响应结构指纹，供后续写映射时比对是否稳定。 */
  shapeFingerprint: string;
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
  evidenceHash: string | null;
}

function streamOf(contract: YonyouReadContractName): string {
  const meta = yonyouReadContractByName(contract);
  if (!meta) throw new Error(`未知的用友契约：${contract}`);
  // stream 用契约路径派生，避免中文名进 checkpoint 键
  return meta.path.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
}

/**
 * 结构指纹：只取"键的形状"，不取值。用来判断两次响应结构是否一致——
 * 将来写字段映射时，先确认指纹稳定再动手，避免照着一次偶发响应写死。
 */
export function yonyouShapeFingerprint(value: unknown, depth = 0): string {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${yonyouShapeFingerprint(value[0], depth + 1)}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${yonyouShapeFingerprint((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  return typeof value;
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
      evidenceHash: integrationRuns.evidenceHash,
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
  if (!existing || existing.status === "succeeded") return null;
  const stale = existing.status === "running"
    && startedAt.getTime() - existing.startedAt.getTime() >= RUN_STALE_AFTER_MS;
  if (existing.status !== "failed" && !stale) return null;

  const [reclaimed]: { id: number; startedAt: Date }[] = await db
    .update(integrationRuns)
    .set({
      ...values,
      status: "running",
      sourceRows: 0,
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
    finishedAt: new Date(),
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
  /** 幂等窗口标识（例如 bizDate）。同 key 重跑直接返回上次结果。 */
  scopeKey: string;
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
  const request = options.request ?? {};
  const stream = streamOf(contract);
  const idempotencyKey = `${CONNECTOR}:${stream}:${scopeKey}`;

  await assertActor(db, actorId);

  const existing = await priorRun(db, idempotencyKey);
  if (existing?.status === "succeeded") {
    return {
      runId: existing.id,
      importJobId: existing.importJobId,
      contract,
      sourceRows: existing.sourceRows,
      stagedRows: existing.stagedRows,
      evidenceHash: existing.evidenceHash ?? "",
      shapeFingerprint: "",
      replayed: true,
      blockedByConsoleGrant: false,
    };
  }

  const attempt = await claimRun(db, {
    connector: CONNECTOR,
    stream,
    status: "running",
    idempotencyKey,
    schemaVersion: SCHEMA_VERSION,
  } as typeof integrationRuns.$inferInsert);
  if (!attempt) throw new Error(`用友 ${stream} 同步已被其他运行占用`);

  try {
    let data: Record<string, unknown>;
    try {
      data = await client.callContract(contract, request);
    } catch (error) {
      if (error instanceof YonyouApiError && error.needsConsoleGrant) {
        // 等授权是正常中间态，不是故障：记成功但不推进 checkpoint
        await db.update(integrationRuns).set({
          status: "succeeded",
          sourceRows: 0,
          stagedRows: 0,
          error: `待控制台授权：${error.code}`,
          finishedAt: new Date(),
        }).where(and(
          eq(integrationRuns.id, attempt.id),
          eq(integrationRuns.startedAt, attempt.startedAt),
        ));
        return {
          runId: attempt.id,
          importJobId: null,
          contract,
          sourceRows: 0,
          stagedRows: 0,
          evidenceHash: "",
          shapeFingerprint: "",
          replayed: false,
          blockedByConsoleGrant: true,
        };
      }
      throw error;
    }

    const records = extractRecordArray(data);
    const shapeFingerprint = yonyouShapeFingerprint(data);
    const envelope = {
      contract,
      connector: CONNECTOR,
      stream,
      schemaVersion: SCHEMA_VERSION,
      scope: { scopeKey, request },
      shapeFingerprint,
      data,
    };
    const evidence = await writeIntegrationEvidence(CONNECTOR, stream, envelope);

    // 找不到记录数组时，把整个 data 当作一行原样落库——诚实优于臆测分页结构
    const rows: unknown[] = records ?? [data];
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

    const finishedAt = new Date();
    // 事务闭包内产生的 jobId 要带出来；用函数内局部变量，切忌模块级共享（并发会串号）
    let stagedJobId: number | null = null;
    await db.transaction(async (tx: AnyDb) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${CONNECTOR}:${stream}`}))`);

      const [newer]: { id: number }[] = await tx
        .select({ id: integrationRuns.id })
        .from(integrationRuns)
        .where(and(
          eq(integrationRuns.connector, CONNECTOR),
          eq(integrationRuns.stream, stream),
          eq(integrationRuns.status, "succeeded"),
          gt(integrationRuns.id, attempt.id),
        ))
        .orderBy(desc(integrationRuns.id))
        .limit(1);
      if (newer) throw new Error(`用友 ${stream} 已有更新成功运行 #${newer.id}，拒绝较旧运行覆盖`);

      const job = await createSourceImportJobInTransaction(tx, {
        template: TARGET_TABLE,
        sourceName: `${stream}-${scopeKey}.json`,
        sourceBytes: evidence.bytes,
        createdBy: actorId,
        idempotencyKey,
        schemaVersion: SCHEMA_VERSION,
        scope: { contract, scopeKey, shapeFingerprint },
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
        requestScope: { contract, scopeKey, request, shapeFingerprint },
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
      replayed: false,
      blockedByConsoleGrant: false,
    };
  } catch (error) {
    await failRun(db, attempt.id, attempt.startedAt, error);
    throw error;
  }
}
