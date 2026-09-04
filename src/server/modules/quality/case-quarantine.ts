/**
 * 质量案件 → 冻结范围内批次（W2 审计 4a）。
 *
 * 事故形态：`quality_cases` 是个孤岛——案件建了、范围固化了、召回激活了，**批次照常出库**。
 * 质量在系统里说的话对库存没有任何约束力，隔离全靠在群里喊。
 *
 * 本模块做两件事，缺一不可：
 *  1) **登记围堵行动**（`quality_actions` kind=containment，targetType=`batch_quarantine`），
 *     无论库存侧这一刻能不能执行——责任与截止日先落地，案件页从此看得到「谁在什么时候该隔离什么」；
 *  2) **调用库存侧隔离能力**（`quarantine-adapter`），成功即把行动置为 completed 并附作业证据；
 *     执行不了（快照仓 / 无隔离库位 / 执行者无仓管角色）则**明说原因**，行动留在 open 等仓库执行。
 *
 * 绝不做的事：直接写 `stock_balances` / `bin_balances`。库存只能经库存域自己的写路径动，
 * 质量域只能请求，不能代劳——这也是适配器存在的理由。
 *
 * 幂等与失败边界（2026-09-04 安全审计 S5）：围堵行动的幂等键由
 * 「案件 × 批次 × 仓库」推导（此前是 `randomUUID()`，等于每次都告诉下游「这是新请求」，
 * 重复发起就重复造行动）；逐批次是独立的原子单元，单行失败不再中断整批，
 * 且汇总审计**无论成败都写**。
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dCmp, dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { deterministicIdempotencyKey } from "@/server/core/idempotency";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";
import {
  DEFAULT_QUARANTINE_PROVIDER_ID,
  listQuarantineScope, resolveBatchQuarantineProvider, type QuarantineScopeRow,
} from "./quarantine-adapter";
import { createQualityAction, transitionQualityAction } from "./service";

/** 围堵行动的目标类型（案件页与库存回执靠它认领这类行动） */
export const QUARANTINE_TARGET_TYPE = "batch_quarantine";
/** 围堵行动默认截止：隔离是止血动作，给的时间必须短 */
export const QUARANTINE_DUE_DAYS = 1;

const quarantineSchema = z.object({
  caseId: z.number().int().positive(),
  /** 围堵行动的责任人（缺省 = 案件责任人） */
  ownerId: z.number().int().positive().optional(),
  reason: z.string().trim().min(2).max(300).optional(),
});

export interface CaseQuarantineLine extends QuarantineScopeRow {
  /** 围堵行动主键；本行整体失败（连行动都没登记成）时为 null */
  actionId: number | null;
  executed: boolean;
  movementId: number | null;
  provider: string;
  /** 未执行的原因（executed=false 时必填） */
  reason: string | null;
  /** 本行是**已存在**的围堵行动（重复发起隔离时的幂等命中，不是新建） */
  replayed: boolean;
  /** 本行整体失败（行动登记或库存请求抛错），需要人工处理 */
  failed: boolean;
}

export interface CaseQuarantineResult {
  caseId: number;
  caseNo: string;
  /** 案件范围里被圈到的批次（去重后） */
  batchIds: number[];
  lines: CaseQuarantineLine[];
  executed: number;
  pending: number;
  /** 本次抛错、需要人工跟进的行数（不再整批中断，见下方注释） */
  failed: number;
  /** 范围内一件现货都没有：不是失败，是「已经没有可隔离的库存」 */
  emptyScope: boolean;
}

/**
 * 案件的隔离范围批次：案件自身绑定的批次 + 召回范围快照里固化的批次。
 * 只取批次主键；库存现货由 `listQuarantineScope` 按 `stock_balances` 正余额算。
 */
export function caseScopeBatchIds(kase: { batchId: number | null; scopeSnapshot: unknown }): number[] {
  const ids = new Set<number>();
  if (kase.batchId != null) ids.add(kase.batchId);
  const snap = kase.scopeSnapshot as { batch?: { id?: unknown } } | null;
  const snapBatchId = snap?.batch?.id;
  if (typeof snapBatchId === "number" && Number.isInteger(snapBatchId)) ids.add(snapBatchId);
  return [...ids].sort((a, b) => a - b);
}

export async function quarantineCaseScope(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<CaseQuarantineResult> {
  // 质量提出、仓管执行；两个角色都能发起（admin 兜底）
  requireAnyRole(user, "quality", "warehouse");
  const v = quarantineSchema.parse(input);
  const db = await resolveDb(dbArg);

  const [kase] = await db.select().from(schema.qualityCases).where(eq(schema.qualityCases.id, v.caseId));
  if (!kase) throw new ApiError(404, `质量案件不存在: #${v.caseId}`);
  if (kase.status === "closed") throw new ApiError(409, "案件已关闭，不再发起隔离");

  const batchIds = caseScopeBatchIds(kase);
  if (batchIds.length === 0) {
    throw new ApiError(409, "该案件没有绑定批次，无法确定隔离范围：请先绑定批次或固化召回范围");
  }
  const scope = await listQuarantineScope(db, batchIds);
  const reason = v.reason ?? `质量案件 ${kase.caseNo} 隔离`;
  const ownerId = v.ownerId ?? kase.ownerId;
  const dueDate = new Date(Date.parse(`${todayShanghai()}T00:00:00Z`) + QUARANTINE_DUE_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const provider = resolveBatchQuarantineProvider();

  /* ── 逐批次是**独立的原子单元**，不是一个大事务（2026-09-04 安全审计 S5）──
     每个批次的写入（登记围堵行动、完成行动）各自在 createQualityAction /
     transitionQualityAction 的事务内连同自己的审计一起落地。此前循环里任何一次抛错
     （最常见：某个仓没有隔离库位 → 409）会直接把整个调用炸掉：
     前面几个批次的行动已经提交、后面的一个都没建，**而汇总审计一条都没写**——
     一次半成品隔离，事后没有任何记录说清「隔到哪一步了」。
     现在单行失败只标记这一行并继续；汇总审计**无论如何都写**，把每一行的结局讲清楚。 */
  const lines: CaseQuarantineLine[] = [];
  for (const row of scope) {
    if (dCmp(row.onHandQty, "0") <= 0) continue;
    const qty = dQty(row.onHandQty);
    /* 幂等键由「案件 × 批次 × 仓库」推导，与下面库存请求用的键同一组实体（S5）。
       此前这里传 randomUUID()：createQualityAction 的 advisory-lock 重放守卫仍在跑，
       但每次都是一个新键，于是永远命中不了——重复点一次「隔离」就再造 N 条围堵行动，
       每条都带责任人和截止日，直接喂给质量案件逾期看门狗。
       键里**不含现货量与截止日**：它们会随库存和日期漂移，放进去等于让防重第二天失效。 */
    const idempotencyKey = deterministicIdempotencyKey(
      "quality-case-quarantine", v.caseId, row.batchId, row.warehouseId,
    );
    try {
      const [existing] = await db
        .select({ id: schema.qualityActions.id, status: schema.qualityActions.status })
        .from(schema.qualityActions)
        .where(eq(schema.qualityActions.idempotencyKey, idempotencyKey));
      /* 已经登记过就直接复用：不重建、也不拿今天的现货量去跟当初的比对
         （createQualityAction 的重放守卫比对整份载荷，库存一变就会 409
         「幂等键已用于不同请求」——那对用户是个读不懂的错误，实际语义只是「已经登记过了」）。 */
      const action = existing ?? await createQualityAction(user, v.caseId, {
        kind: "containment",
        title: `隔离 ${row.skuCode} 批次 ${row.batchNo}（${row.warehouseCode}）`,
        description: `${reason}：在 ${row.warehouseName}（${row.warehouseCode}）冻结批次 ${row.batchNo} 现货 ${qty}。`
          + "隔离由库存域的隔离作业执行，质量域只提出请求、不直接改库存。",
        ownerId,
        dueDate,
        targetType: QUARANTINE_TARGET_TYPE,
        targetRef: `batch#${row.batchId}@warehouse#${row.warehouseId}`,
        quantity: qty,
        idempotencyKey,
      }, db);

      const outcome = await provider(user, {
        warehouseId: row.warehouseId,
        skuId: row.skuId,
        batchId: row.batchId,
        qty,
        reason,
        idempotencyKey: `quality-case:${v.caseId}:batch:${row.batchId}:wh:${row.warehouseId}`,
      }, db);

      /* 已经 completed 的行动不再走一次完成流转：状态机会 409「该行动已完成」，
         把一次**幂等重放**变成一次报错。重放的正确结局是「什么都没变」。 */
      const alreadyCompleted = existing?.status === "completed";
      if (outcome.ok && !alreadyCompleted) {
        // 执行成功 → 行动完成（证据 = 库存侧作业主键；完成人与验证人分离的纪律由 service 保证）
        await transitionQualityAction(user, action.id, {
          operation: "complete",
          evidenceRef: `${outcome.provider}#${outcome.movementId}`,
          outcome: `已在 ${row.warehouseCode} 隔离 ${qty}`,
        }, db);
      }
      lines.push({
        ...row,
        actionId: action.id,
        executed: outcome.ok,
        movementId: outcome.movementId,
        provider: outcome.provider,
        reason: outcome.reason,
        replayed: Boolean(existing),
        failed: false,
      });
    } catch (error) {
      /* 这一行没做成，但其余批次仍要继续——隔离是止血动作，
         因为第三个仓没有隔离库位就把前两个仓也放着不隔，是更坏的结果。 */
      lines.push({
        ...row,
        actionId: null,
        executed: false,
        movementId: null,
        provider: DEFAULT_QUARANTINE_PROVIDER_ID,
        reason: error instanceof Error ? error.message : String(error),
        replayed: false,
        failed: true,
      });
    }
  }

  const result: CaseQuarantineResult = {
    caseId: v.caseId,
    caseNo: kase.caseNo,
    batchIds,
    lines,
    executed: lines.filter((l) => l.executed).length,
    pending: lines.filter((l) => !l.executed).length,
    failed: lines.filter((l) => l.failed).length,
    emptyScope: lines.length === 0,
  };

  /* 汇总审计：无论成功、部分失败还是全失败都必须落库。
     它回答的是「谁在什么时候对哪个案件发起了隔离、结果如何」，
     恰恰在部分失败时最需要——此前那正是它唯一不会被写的时候。 */
  await writeAudit(db, {
    userId: user.id,
    entity: "quality_case",
    entityId: v.caseId,
    action: "quarantine_scope",
    after: {
      caseNo: kase.caseNo,
      batchIds,
      executed: result.executed,
      pending: result.pending,
      failed: result.failed,
      emptyScope: result.emptyScope,
      lines: lines.map((l) => ({
        batchId: l.batchId, warehouseId: l.warehouseId, qty: l.onHandQty,
        actionId: l.actionId, executed: l.executed, movementId: l.movementId,
        provider: l.provider, reason: l.reason, replayed: l.replayed, failed: l.failed,
      })),
    },
  });
  return result;
}
