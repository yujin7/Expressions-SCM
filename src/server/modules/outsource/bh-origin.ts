import { and, eq, inArray, or, sql } from "drizzle-orm";
import { auditLogs, sopExecutionDrafts } from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";

/** Only returns provenance, never reinterprets the original frozen plan as today's edited quantity. */
export async function getBhOrigin(db: AnyDb, id: number, docNo: string) {
  const [plans, events] = await Promise.all([
    db.select({ id: sopExecutionDrafts.id }).from(sopExecutionDrafts).where(eq(sopExecutionDrafts.bhId, id)).limit(1),
    db.selectDistinct({ action: auditLogs.action }).from(auditLogs).where(or(
      and(inArray(auditLogs.action, ["draft_bh", "first_order_draft"]), sql`${auditLogs.after}->>'docNo' = ${docNo}`),
      and(eq(auditLogs.entity, "bh"), eq(auditLogs.entityId, id), eq(auditLogs.action, "update_draft")),
    )),
  ]);
  const edited = events.some((e: { action: string }) => e.action === "update_draft");
  const fromSuggestion = plans.length > 0 || events.some((e: { action: string }) => e.action !== "update_draft");
  const source = plans.length ? "冻结计划" : events.some((e: { action: string }) => e.action === "first_order_draft") ? "新品首单" : "补货建议";
  return {
    fromSuggestion, edited,
    note: fromSuggestion
      ? `来源：${source}。${edited ? "草稿已人工修正，当前需求不等同原始建议量；修改原因与前后值已留审计。" : "请结合当前库存、在途和需求核对，不代表当前仍需按原量下单。"}`
      : `人工直录单据——系统未参与数量测算${edited ? "；草稿已修正，修改原因与前后值已留审计" : ""}`,
  };
}
