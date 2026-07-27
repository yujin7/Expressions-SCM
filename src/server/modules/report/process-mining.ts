import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getDbAsync } from "@/db";
import { auditLogs } from "@/db/schema";
import { type SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import {
  mineProcessEvents,
  type ProcessAuditEvent,
  type ProcessMiningResult,
} from "@/server/rules/process-mining";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export const PROCESS_ENTITY_DEFS = [
  { value: "bh", label: "备货申请" },
  { value: "wo", label: "委外工单" },
  { value: "po", label: "采购订单" },
  { value: "jg", label: "加工通知单" },
  { value: "fl", label: "发料单" },
  { value: "tl", label: "退料单" },
  { value: "sh", label: "收货单" },
  { value: "ct", label: "采购退货单" },
  { value: "stock_doc", label: "库存单据" },
  { value: "pd_doc", label: "盘点单" },
  { value: "js", label: "结算单" },
] as const;

const PROCESS_ENTITIES = PROCESS_ENTITY_DEFS.map((definition) => definition.value);
const PROCESS_ENTITY_SET = new Set<string>(PROCESS_ENTITIES);
const EVENT_LIMIT = 50_000;

export const processMiningQuerySchema = z.object({
  windowDays: z.coerce.number().int().refine((value) => [30, 90, 180, 365].includes(value), {
    message: "窗口只支持 30/90/180/365 天",
  }).default(90),
  entity: z.string().trim().default("all").refine(
    (value) => value === "all" || PROCESS_ENTITY_SET.has(value),
    { message: "不支持的流程对象" },
  ),
});

export interface ProcessMiningDto extends ProcessMiningResult {
  generatedAt: string;
  windowDays: number;
  windowFrom: string;
  entity: string;
  entityOptions: { value: string; label: string }[];
  truncated: boolean;
  sourceEventCount: number;
}

export function guardProcessMining(user: SessionUser): void {
  if (user.roles.includes("admin") || user.roles.some((role) => ["pmc", "finance"].includes(role))) return;
  throw new ApiError(403, "仅管理员、生产计划或财务可查看流程效率分析");
}

/**
 * E3-07: append-only audit events → stage duration, bottleneck, and path variants.
 * No employee leaderboard and no workflow writes are produced by this read model.
 */
export async function getProcessMining(
  user: SessionUser,
  query: unknown,
  dbArg?: AnyDb,
  now = new Date(),
): Promise<ProcessMiningDto> {
  guardProcessMining(user);
  const parsed = processMiningQuerySchema.parse(query ?? {});
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const windowFrom = new Date(now.getTime() - parsed.windowDays * 86_400_000);
  const conditions = [
    gte(auditLogs.createdAt, windowFrom),
    parsed.entity === "all"
      ? inArray(auditLogs.entity, PROCESS_ENTITIES)
      : eq(auditLogs.entity, parsed.entity),
  ];
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        entity: auditLogs.entity,
        entityId: auditLogs.entityId,
        action: auditLogs.action,
        canonicalEvent: auditLogs.canonicalEvent,
        eventDomain: auditLogs.eventDomain,
        eventVersion: auditLogs.eventVersion,
        isStateChange: auditLogs.isStateChange,
        createdAt: auditLogs.createdAt,
        after: auditLogs.after,
      })
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(EVENT_LIMIT),
    db.select({ total: sql<number>`count(*)::int` }).from(auditLogs).where(where),
  ]);

  const mined = mineProcessEvents(rows as ProcessAuditEvent[]);
  return {
    ...mined,
    generatedAt: now.toISOString(),
    windowDays: parsed.windowDays,
    windowFrom: windowFrom.toISOString(),
    entity: parsed.entity,
    entityOptions: PROCESS_ENTITY_DEFS.map(({ value, label }) => ({ value, label })),
    truncated: total > rows.length,
    sourceEventCount: total,
  };
}
