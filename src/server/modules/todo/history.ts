import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { auditLogs, users, workItems } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { isWorkItemVisible } from "./service";
import { capacitySource } from "@/server/modules/outsource/capacity-source";
import { resolveChannelScope } from "@/server/core/data-scope";

export const workItemNoteSchema = z.object({
  note: z.string().trim().min(5, "请记录至少5个字的跟进或结果依据").max(1000),
  requestId: z.string().uuid(),
}).strict();
export const workItemHistoryQuery = z.object({
  before: z.coerce.number().int().positive().max(2_147_483_647).optional(),
}).strict();
const ACTIONS = ["create", "assign", "update", "complete", "cancel", "reopen", "follow_up", "capacity_check"];

export interface WorkItemHistoryEvent {
  id: number;
  at: string;
  actorName: string;
  action: string;
  note: string | null;
  status: string | null;
  assigneeId: number | null;
  requestId: string | null;
  sourceAlertId?: number;
}
export interface WorkItemHistoryPage { rows: WorkItemHistoryEvent[]; nextBefore: number | null }

/** Explicit projection: never expose arbitrary audit before/after, IP or other entity payloads. */
function eventDto(row: typeof auditLogs.$inferSelect & { actorName?: string | null }): WorkItemHistoryEvent {
  const after = row.after && typeof row.after === "object" && !Array.isArray(row.after) ? row.after as Record<string, unknown> : {};
  return {
    id: row.id, at: row.createdAt.toISOString(), actorName: row.actorName ?? `用户 #${row.userId}`, action: row.action,
    note: typeof after.note === "string" ? after.note : null,
    status: typeof after.status === "string" && ["open", "in_progress", "done", "cancelled"].includes(after.status) ? after.status : null,
    assigneeId: typeof after.assigneeId === "number" && Number.isSafeInteger(after.assigneeId) ? after.assigneeId : null,
    requestId: ["follow_up", "capacity_check"].includes(row.action) && typeof after.requestId === "string" ? after.requestId : null,
  };
}

export async function listWorkItemHistory(id: number, query: unknown, actor: SessionUser, dbArg?: AnyDb): Promise<WorkItemHistoryPage> {
  const { before } = workItemHistoryQuery.parse(query);
  const db = dbArg ?? await getDbAsync();
  return db.transaction(async (tx: AnyDb) => {
    // Share lock binds visibility to the same item version while selecting its history.
    const [item] = await tx.select().from(workItems).where(eq(workItems.id, id)).for("share");
    if (!item || !isWorkItemVisible(item, actor)) throw new ApiError(404, "待办不存在");
    const rows = await tx.select({ ...{
      id: auditLogs.id, userId: auditLogs.userId, entity: auditLogs.entity, entityId: auditLogs.entityId,
      action: auditLogs.action, createdAt: auditLogs.createdAt, after: auditLogs.after,
    }, actorName: users.name }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.userId))
      .where(and(eq(auditLogs.entity, "work_item"), eq(auditLogs.entityId, id), inArray(auditLogs.action, ACTIONS), before ? lt(auditLogs.id, before) : undefined))
      .orderBy(desc(auditLogs.id)).limit(21);
    const page = rows.slice(0, 20);
    const sourceAccess = new Map<string, Promise<void>>();
    const safeRows = await Promise.all(page.map(async (row: typeof auditLogs.$inferSelect) => {
      const dto = eventDto(row);
      if (row.action !== "capacity_check") return dto;
      const context = (row.after as Record<string, unknown> | null)?.capacity as { alertId?: unknown; skuId?: unknown;
        source?: { category?: unknown; channelIds?: unknown } } | undefined;
      if (!context || !Number.isSafeInteger(context.alertId) || !Number.isSafeInteger(context.skuId)) {
        return { ...dto, note: "产能依据格式无法核验，请联系管理员", requestId: null };
      }
      const key = `${context.alertId}:${context.skuId}`;
      if (!sourceAccess.has(key)) sourceAccess.set(key, capacitySource(actor, context.alertId as number, context.skuId as number, tx).then(() => undefined));
      try {
        await sourceAccess.get(key);
        const scope = resolveChannelScope(actor, null);
        if (scope.channelIds !== null && context.source?.category !== "inventory_cover") {
          const ids = context.source?.channelIds;
          if (context.source?.category !== "sales_spike" || !Array.isArray(ids) || !ids.length
            || !ids.every(id => typeof id === "number" && Number.isSafeInteger(id) && scope.channelIds!.includes(id))) {
            throw new ApiError(403, "历史产能依据超出当前渠道范围或缺少归属证据");
          }
        }
      }
      catch (error) {
        if (!(error instanceof ApiError) || ![400, 403, 404].includes(error.status)) throw error;
        return { ...dto, note: "已保存产能核对依据；当前无权读取其来源内容", requestId: null };
      }
      return { ...dto, sourceAlertId: context.alertId as number };
    }));
    return { rows: safeRows, nextBefore: rows.length > 20 ? page[page.length - 1].id : null };
  });
}

/** One append-only writer. The item row lock serializes request-ID lookup + append, including replay. */
export async function appendWorkItemNote(id: number, raw: z.input<typeof workItemNoteSchema>, actor: SessionUser, dbArg?: AnyDb): Promise<{ eventId: number; replayed: boolean }> {
  const input = workItemNoteSchema.parse(raw);
  const db = dbArg ?? await getDbAsync();
  return db.transaction(async (tx: AnyDb) => {
    const [item] = await tx.select().from(workItems).where(eq(workItems.id, id)).for("update");
    if (!item || !isWorkItemVisible(item, actor)) throw new ApiError(404, "待办不存在");
    const identity = and(eq(auditLogs.entity, "work_item"), eq(auditLogs.entityId, id), eq(auditLogs.action, "follow_up"), sql`${auditLogs.after}->>'requestId' = ${input.requestId}`);
    const [existing] = await tx.select({ id: auditLogs.id, userId: auditLogs.userId, after: auditLogs.after }).from(auditLogs).where(identity).limit(1);
    if (existing) {
      if (existing.userId !== actor.id || existing.after?.note !== input.note) throw new ApiError(409, "该提交标识已用于其他跟进内容，请先核对历史记录");
      return { eventId: existing.id, replayed: true };
    }
    await writeAudit(tx, { userId: actor.id, entity: "work_item", entityId: id, action: "follow_up", after: input });
    const [written] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(identity).limit(1);
    if (!written) throw new Error("Follow-up audit was not persisted");
    // Do NOT touch work_items.updatedAt: it anchors the existing seven-day reopen policy.
    // Notes neither close/reopen tasks nor acknowledge/close their source alerts; no notification fan-out.
    return { eventId: written.id, replayed: false };
  });
}
