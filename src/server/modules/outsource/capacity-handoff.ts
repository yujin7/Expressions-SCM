import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, workItems } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { isWorkItemVisible } from "@/server/modules/todo/service";
import { getCapacityCheck } from "./capacity-check";
import { capacityFingerprint, capacitySource } from "./capacity-source";
import { requireAnyRole, resolveDb, type AnyDb } from "./common";

const id = z.number().int().positive().max(2_147_483_647);
export const capacityHandoffSchema = z.object({
  skuId: id, alertId: id, supplierId: id, workItemId: id, assigneeId: id,
  dueDate: z.string(), candidateQty: z.string(), evidenceKey: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(), note: z.string().trim().min(5, "请说明至少5字的待核实事项").max(1000),
}).strict();

/** Append evidence only, to the explicitly confirmed existing owner. No task projection or dispatch. */
export async function attachCapacityCheck(raw: unknown, actor: SessionUser, dbArg?: AnyDb) {
  requireAnyRole(actor, "purchasing", "pmc", "ops");
  const input = capacityHandoffSchema.parse(raw);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [item] = await tx.select().from(workItems).where(eq(workItems.id, input.workItemId)).for("update");
    if (!item || !isWorkItemVisible(item, actor)) throw new ApiError(404, "承接待办不存在或不可见");
    // Source authorization precedes replay too: a previous receipt must not bypass revoked scope.
    await capacitySource(actor, input.alertId, input.skuId, tx);
    const requestKey = capacityFingerprint(input);
    const identity = and(eq(auditLogs.entity, "work_item"), eq(auditLogs.entityId, item.id),
      eq(auditLogs.action, "capacity_check"), sql`${auditLogs.after}->>'requestId' = ${input.requestId}`);
    const [prior] = await tx.select().from(auditLogs).where(identity).limit(1);
    if (prior) {
      const priorAfter = prior.after as Record<string, unknown> | null;
      if (prior.userId !== actor.id || priorAfter?.requestKey !== requestKey) throw new ApiError(409, "该提交标识已用于其他产能依据，请先核对待办历史");
      return { itemId: item.id as number, eventId: prior.id as number, replayed: true };
    }
    if (item.sourceKind !== "alert" || item.sourceRef !== String(input.alertId)) throw new ApiError(409, "待办不属于该来源告警，不能关联");
    if (!["open", "in_progress"].includes(item.status) || item.assigneeId !== input.assigneeId) throw new ApiError(409, "待办状态或负责人已变化，请重新核对承接项");
    const check = await getCapacityCheck(actor, { skuId: input.skuId, alertId: input.alertId,
      supplierId: input.supplierId, dueDate: input.dueDate, candidateQty: input.candidateQty }, tx);
    const target = check.handoff?.items.find(row => row.id === item.id);
    if (!target || check.handoff?.source.status !== "open") throw new ApiError(409, "来源已关闭或责任人已失效，请重新核对");
    if (check.evidenceKey !== input.evidenceKey) throw new ApiError(409, "来源或产能依据已变化，请重新核对情景再保存");
    const scenario = check.scenario!;
    const factory = check.factories.find(row => row.id === scenario.supplierId)!;
    const signal = scenario.signal;
    const declared = signal.declared;
    const capturedAt = new Date().toISOString();
    const note = [
      `人工产能核对 · ${check.sku.code} ${check.sku.name}；${factory.code} ${factory.name}（${factory.statusLabel}）`,
      `来源告警 #${input.alertId}：${check.handoff!.source.title}；最近命中 ${check.handoff!.source.lastHitAt ?? "未知"}`,
      `承接待办 #${item.id}；确认负责人 ${target.assigneeName}；记录时点 ${capturedAt}`,
      `拟新增 ${scenario.candidateQty} ${check.sku.baseUom}，拟交付 ${scenario.dueDate}；本系统未结JG全单量 ${signal.scheduledQty}，合计情景 ${signal.projectedQty}（同单位）。`,
      `申报：${declared.reason}；正常上限 ${declared.normalLimitQty ?? "未知"}，加班上限 ${declared.surgeLimitQty ?? "未知"}；原申报 ${declared.declaredMonthlyCapacity ?? "未填"} ${declared.capacityUom ?? ""}，加班比例 ${declared.surgeCapacityPct ?? "未知"}%；有效期 ${declared.capacityValidFrom ?? "未知"} 至 ${declared.capacityValidUntil ?? "未知"}；依据：${declared.capacityEvidence ?? "未提供"}`,
      `历史口径：${signal.explanation}；完整月窗口 ${signal.historyWindow.from} 至 ${signal.historyWindow.to}；缺交期JG ${signal.undatedOrders} 张。`,
      `待核实事项：${input.note}`,
      "仅保存核对时点的人工情景，不含其他客户占用，不是可承诺余量或协议；不下单、不锁产能、不改派、不关闭待办或源告警。请在本待办追加实际跟进与结果依据。",
    ].join("\n");
    await writeAudit(tx, { userId: actor.id, entity: "work_item", entityId: item.id, action: "capacity_check",
      after: { requestId: input.requestId, requestKey, note, assigneeId: target.assigneeId, capacity: { version: 1, skuId: input.skuId,
        alertId: input.alertId, capturedAt, evidenceKey: input.evidenceKey, sku: check.sku,
        factory, scenario, source: check.handoff!.source, assigneeId: target.assigneeId } } });
    const [written] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(identity).limit(1);
    if (!written) throw new Error("Capacity handoff audit was not persisted");
    return { itemId: item.id as number, eventId: written.id as number, replayed: false };
  });
}
