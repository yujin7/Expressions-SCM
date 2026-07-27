import { auditLogs } from "@/db/schema";
import { classifyEvent } from "@/server/core/event-taxonomy";

export const AUDIT_EVENT_VERSION = "event-v1";

/**
 * 审计写入器（体检审计 #1 整改）：规格 §8「审计全留痕」的唯一落点。
 * 约定：所有 service 写路径在同一事务内调用；批量导入按任务记 1 行（文件hash+行数），
 * 不逐行存 before/after（《01》§3 audit_log 约定）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export async function writeAudit(
  db: AnyDb,
  i: {
    userId: number;
    entity: string; // 表名/单据类型，如 "stock_doc" | "sku" | "bom"
    entityId?: number | null;
    action: string; // create | update | submit | approve | reject | reverse | activate | login_locked …
    before?: unknown;
    after?: unknown;
    ip?: string | null;
  },
): Promise<void> {
  const event = classifyEvent(i.entity, i.action);
  await db.insert(auditLogs).values({
    userId: i.userId,
    entity: i.entity,
    entityId: i.entityId ?? null,
    action: i.action,
    canonicalEvent: event.canonical,
    eventDomain: event.domain,
    eventVersion: AUDIT_EVENT_VERSION,
    isStateChange: event.isStateChange,
    before: i.before ?? null,
    after: i.after ?? null,
    ip: i.ip ?? null,
  });
}
