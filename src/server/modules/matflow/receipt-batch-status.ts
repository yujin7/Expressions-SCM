import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { auditLogs, poDocs, shDocs, woDocs } from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";

/** Shared acknowledgement contract for the queue and detail; malformed evidence stays pending. */
function validResult(after: SQL, woId: SQL) {
  return sql`${after}->'woId'=to_jsonb(${woId}) and (
    ${after}->>'state'='not_generated' or (
      ${after}->>'state'='created' and jsonb_typeof(${after}->'jgId')='number'
      and ${after}->>'jgId' ~ '^[1-9][0-9]{0,9}$'
      and ${after}->'jgId' <= '2147483647'::jsonb
      and jsonb_typeof(${after}->'docNo')='string' and length(trim(${after}->>'docNo'))>0
    )
  )`;
}

/** Only an intent committed with this receipt can be pending; legacy silence is not failure. */
export const receiptBatchPending = sql<boolean>`${shDocs.status}='completed' and ${shDocs.sourceType}='po' and exists (
  select 1 from audit_logs request
  join po_docs source_po on source_po.id=${shDocs.sourceId}
  join wo_docs request_wo on request.after->>'autoBatchWoId'=request_wo.id::text
  where request.entity='sh' and request.entity_id=${shDocs.id} and request.action='inbound'
    and request.after->>'autoBatchRequested'='true'
    and request.after->>'sourceId'=${shDocs.sourceId}::text
    and not exists (select 1 from audit_logs done where done.entity='sh' and done.entity_id=${shDocs.id}
      and done.action='receipt_batch_checked' and done.after->>'requestId'=request.id::text
      and ${validResult(sql`done.after`, sql`request_wo.id`)})
)`;

export interface ReceiptBatchReview {
  requestId: number; woId: number; woDocNo: string; requestedAt: Date;
  checkedAt: Date | null; state: "pending" | "created" | "not_generated";
  jgId: number | null; docNo: string | null; reason: string | null;
}

export async function getReceiptBatchReview(db: AnyDb, shId: number): Promise<ReceiptBatchReview | null> {
  const [request]: { id: number; createdAt: Date; woId: number; woDocNo: string }[] = await db
    .select({ id: auditLogs.id, createdAt: auditLogs.createdAt, woId: woDocs.id, woDocNo: woDocs.docNo })
    .from(shDocs).innerJoin(poDocs, eq(poDocs.id, shDocs.sourceId))
    .innerJoin(auditLogs, and(eq(auditLogs.entity, "sh"), eq(auditLogs.entityId, shDocs.id), eq(auditLogs.action, "inbound")))
    .innerJoin(woDocs, sql`${auditLogs.after}->>'autoBatchWoId'=${woDocs.id}::text`)
    .where(and(eq(shDocs.id, shId), eq(shDocs.status, "completed"), eq(shDocs.sourceType, "po"),
      sql`${auditLogs.after}->>'autoBatchRequested'='true'`,
      sql`${auditLogs.after}->>'sourceId'=${shDocs.sourceId}::text`))
    .orderBy(desc(auditLogs.id)).limit(1);
  if (!request) return null;
  const [done]: { createdAt: Date; after: { state?: string; woId?: number; jgId?: number; docNo?: string; reason?: string } }[] = await db
    .select({ createdAt: auditLogs.createdAt, after: auditLogs.after }).from(auditLogs)
    .where(and(eq(auditLogs.entity, "sh"), eq(auditLogs.entityId, shId), eq(auditLogs.action, "receipt_batch_checked"),
      sql`${auditLogs.after}->>'requestId'=${String(request.id)}`,
      validResult(sql`${auditLogs.after}`, sql`${request.woId}::integer`)))
    .orderBy(desc(auditLogs.id)).limit(1);
  const value = done?.after;
  const valid = Boolean(done);
  return { requestId: request.id, woId: request.woId, woDocNo: request.woDocNo, requestedAt: request.createdAt,
    checkedAt: valid ? done.createdAt : null, state: valid ? value!.state as "created" | "not_generated" : "pending",
    jgId: valid && value!.state === "created" ? value!.jgId! : null,
    docNo: valid && value!.state === "created" ? value!.docNo! : null,
    reason: valid && typeof value!.reason === "string" ? value!.reason : null };
}
