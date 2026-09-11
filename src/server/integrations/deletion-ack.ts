/**
 * 上游删除墓碑：对全量快照缺失的具体记录保留人工核实依据，不承诺签署即恢复同步。
 *
 * 历史故障（2026-09-04 → 09-05）：`jst-item-master-mirror-observation` 从 6448 掉到 6447，
 * 该全量镜像流拒绝替代批次 #524。拒绝是对的——没有墓碑就分不清「上游删了一条」与
 * 「权限/分页缩了，只看得到一部分」，后者当成前者接受，观察基线会被悄悄削掉一截。
 * 当时缺少逐记录确认路径；一条流失败可能阻断同次顺序任务中的后续流，
 * 但不等于整个连接器停摆。现状与恢复必须逐流取证，不能由这段历史推断。
 *
 * 本模块补的就是那条路径，且刻意保持窄：
 *  - 一次签字只确认**一条**具体记录的删除依据，不存在「以后丢的都算数」；
 *  - 只能为**真的出现过**的记录签字（回查 staging_rows）——不能给系统没见过的 ID 预签；
 *  - 必填依据；仅管理员；同事务写审计；签错了能撤销，同样留痕。
 *  - **墓碑不绕过完整性守卫**：保存的 rowNo 是规范化 sourceRecordId 顺序，不是 API 分页顺序；
 *    尾部缺失只能提示疑似截断，不能证明根因。判定覆盖所有消失记录，即使逐条签满仍可拒绝。
 *    这条在 jiandaoyun-sync 里执行，本模块只负责「谁签了什么」；签署后仍须逐流重跑验收。
 *  - 全量快照、滚动时间窗与空观察分别遵循各自留证/替代规则，不把所有少行都当作上游删除。
 *    当前业务裁决与恢复边界见 docs/spec/CURRENT.md 的 D69。
 */
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";

export interface DeletionAckInput {
  connector: string;
  stream: string;
  sourceRecordId: string;
  reason: string;
}

export interface DeletionAckRow {
  id: number;
  connector: string;
  stream: string;
  sourceRecordId: string;
  observedInJobId: number;
  reason: string;
  ackedBy: number;
  ackedAt: Date;
}

/** 已签字的 sourceRecordId 集合（同步流程用它把「已确认删除」从缺失集里减掉） */
export async function loadAckedDeletions(
  db: AnyDb,
  connector: string,
  stream: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ sourceRecordId: schema.integrationRecordDeletions.sourceRecordId })
    .from(schema.integrationRecordDeletions)
    .where(and(
      eq(schema.integrationRecordDeletions.connector, connector),
      eq(schema.integrationRecordDeletions.stream, stream),
    ));
  return new Set(rows.map((r: { sourceRecordId: string }) => r.sourceRecordId));
}

/**
 * 登记一条删除墓碑。
 *
 * 校验顺序即安全顺序：先确认这条记录**真的在某个已完成批次里出现过**，再落库。
 * 少了这一步，任何人都能为一个从未存在的 ID 预先签字，
 * 等某次真的发生截断时它就成了现成的放行券。
 */
export async function ackRecordDeletion(
  user: SessionUser,
  input: DeletionAckInput,
  dbArg?: AnyDb,
): Promise<DeletionAckRow> {
  if (!user.roles.includes("admin")) {
    throw new ApiError(403, "确认上游删除会放行数据基线，仅管理员可操作");
  }
  const connector = input.connector.trim();
  const stream = input.stream.trim();
  const sourceRecordId = input.sourceRecordId.trim();
  const reason = input.reason.trim();
  if (!connector || !stream || !sourceRecordId) {
    throw new ApiError(400, "connector / stream / sourceRecordId 均不能为空");
  }
  if (reason.length < 4) {
    throw new ApiError(400, "请写明确认依据（至少 4 个字）——一年后要有人能看懂当时凭什么放行");
  }

  const db = await resolveDb(dbArg);
  const observed: { jobId: number }[] = await db
    .select({ jobId: schema.stagingRows.importJobId })
    .from(schema.stagingRows)
    .innerJoin(schema.importJobs, eq(schema.importJobs.id, schema.stagingRows.importJobId))
    .where(and(
      eq(schema.importJobs.status, "done"),
      sql`${schema.stagingRows.payload} ->> 'sourceRecordId' = ${sourceRecordId}`,
      sql`${schema.stagingRows.payload} -> '_source' ->> 'contractKey' = ${stream}`,
    ))
    .orderBy(sql`${schema.stagingRows.importJobId} desc`)
    .limit(1);
  if (observed.length === 0) {
    throw new ApiError(
      400,
      `记录 ${sourceRecordId} 从未在 ${stream} 的任何已完成批次里出现过——不能为系统没见过的记录预先签字`,
    );
  }

  const rows = await db.transaction(async (tx: AnyDb) => {
    const inserted: DeletionAckRow[] = await tx
      .insert(schema.integrationRecordDeletions)
      .values({
        connector, stream, sourceRecordId,
        observedInJobId: observed[0].jobId,
        reason, ackedBy: user.id,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) throw new ApiError(409, `记录 ${sourceRecordId} 已经确认过，无需重复签字`);
    await writeAudit(tx, {
      userId: user.id,
      action: "integration.record_deletion.ack",
      entity: "integration_record_deletions",
      entityId: inserted[0].id,
      after: { connector, stream, sourceRecordId, observedInJobId: observed[0].jobId, reason },
    });
    return inserted;
  });
  return rows[0];
}

/** 撤销签字（签错了要能收回；同样仅管理员、同样留痕） */
export async function revokeRecordDeletionAck(
  user: SessionUser,
  id: number,
  dbArg?: AnyDb,
): Promise<void> {
  if (!user.roles.includes("admin")) throw new ApiError(403, "仅管理员可撤销确认");
  const db = await resolveDb(dbArg);
  await db.transaction(async (tx: AnyDb) => {
    const [before] = await tx
      .select()
      .from(schema.integrationRecordDeletions)
      .where(eq(schema.integrationRecordDeletions.id, id));
    if (!before) throw new ApiError(404, "无此确认记录");
    await tx.delete(schema.integrationRecordDeletions).where(eq(schema.integrationRecordDeletions.id, id));
    await writeAudit(tx, {
      userId: user.id,
      action: "integration.record_deletion.revoke",
      entity: "integration_record_deletions",
      entityId: id,
      before,
    });
  });
}

/** 列出墓碑（运维页展示：谁、什么时候、凭什么放行了哪一条） */
export async function listRecordDeletions(
  connector: string,
  stream: string | undefined,
  dbArg?: AnyDb,
): Promise<DeletionAckRow[]> {
  const db = await resolveDb(dbArg);
  const where = stream
    ? and(
      eq(schema.integrationRecordDeletions.connector, connector),
      eq(schema.integrationRecordDeletions.stream, stream),
    )
    : eq(schema.integrationRecordDeletions.connector, connector);
  return db
    .select()
    .from(schema.integrationRecordDeletions)
    .where(where)
    .orderBy(sql`${schema.integrationRecordDeletions.ackedAt} desc`);
}
