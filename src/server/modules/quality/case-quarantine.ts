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
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dCmp, dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";
import {
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
  actionId: number;
  executed: boolean;
  movementId: number | null;
  provider: string;
  /** 未执行的原因（executed=false 时必填） */
  reason: string | null;
}

export interface CaseQuarantineResult {
  caseId: number;
  caseNo: string;
  /** 案件范围里被圈到的批次（去重后） */
  batchIds: number[];
  lines: CaseQuarantineLine[];
  executed: number;
  pending: number;
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

  const lines: CaseQuarantineLine[] = [];
  for (const row of scope) {
    if (dCmp(row.onHandQty, "0") <= 0) continue;
    const qty = dQty(row.onHandQty);
    // 围堵行动先落地：库存能不能马上隔，不影响「有人要负责隔」这件事被记下来
    const action = await createQualityAction(user, v.caseId, {
      kind: "containment",
      title: `隔离 ${row.skuCode} 批次 ${row.batchNo}（${row.warehouseCode}）`,
      description: `${reason}：在 ${row.warehouseName}（${row.warehouseCode}）冻结批次 ${row.batchNo} 现货 ${qty}。`
        + "隔离由库存域的隔离作业执行，质量域只提出请求、不直接改库存。",
      ownerId,
      dueDate,
      targetType: QUARANTINE_TARGET_TYPE,
      targetRef: `batch#${row.batchId}@warehouse#${row.warehouseId}`,
      quantity: qty,
      idempotencyKey: randomUUID(),
    }, db);

    const outcome = await provider(user, {
      warehouseId: row.warehouseId,
      skuId: row.skuId,
      batchId: row.batchId,
      qty,
      reason,
      idempotencyKey: `quality-case:${v.caseId}:batch:${row.batchId}:wh:${row.warehouseId}`,
    }, db);

    if (outcome.ok) {
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
    });
  }

  const result: CaseQuarantineResult = {
    caseId: v.caseId,
    caseNo: kase.caseNo,
    batchIds,
    lines,
    executed: lines.filter((l) => l.executed).length,
    pending: lines.filter((l) => !l.executed).length,
    emptyScope: lines.length === 0,
  };

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
      emptyScope: result.emptyScope,
      lines: lines.map((l) => ({
        batchId: l.batchId, warehouseId: l.warehouseId, qty: l.onHandQty,
        actionId: l.actionId, executed: l.executed, movementId: l.movementId,
        provider: l.provider, reason: l.reason,
      })),
    },
  });
  return result;
}
