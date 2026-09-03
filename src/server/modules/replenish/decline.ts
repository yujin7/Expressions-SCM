/**
 * 「已复核并放弃」写路径（闭环审计 #12）：计划员看过某 SKU 的补货建议、判断不需要下单时留痕。
 *
 * 此前只有 draft_bh 有审计，放弃完全不可见——采纳率把"没看"与"看过不需要"混在一起。
 * 只写 audit_logs（entity=replenish, action=decline_suggestion, entityId=skuId），不建表、不改建议、不开单据（R13）。
 * 读侧：report/closed-loop.ts 单列 declined 计数，不进采纳率分母。
 * 幂等：同人同 SKU 同业务日重复提交只保留第一条（after.businessDate 相同即视为重复）。
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";

export const DECLINE_REASON_CODES = ["reference_stock_sufficient", "demand_overstated", "supply_already_arranged", "delisting", "other"] as const;
export type DeclineReasonCode = (typeof DECLINE_REASON_CODES)[number];

export const declineSuggestionSchema = z.object({
  skuId: z.number().int().positive({ message: "必须选择 SKU" }),
  reason: z.string().trim().min(1, "必须填写放弃原因").max(500),
  reasonCode: z.enum(DECLINE_REASON_CODES).optional().default("other"),
});
export type DeclineSuggestionInput = z.infer<typeof declineSuggestionSchema>;

export interface DeclineSuggestionResult {
  skuId: number;
  skuCode: string;
  businessDate: string;
  reasonCode: DeclineReasonCode;
  /** 同人同 SKU 同业务日已放弃过：本次不再写第二条 */
  duplicate: boolean;
}

export async function declineReplenishSuggestion(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<DeclineSuggestionResult> {
  requireAnyRole(user, "pmc");
  const v = declineSuggestionSchema.parse(input);
  const db = await resolveDb(dbArg);
  const businessDate = todayShanghai();
  return db.transaction(async (tx: AnyDb) => {
    const [sku] = await tx.select({ id: schema.skus.id, code: schema.skus.code }).from(schema.skus).where(eq(schema.skus.id, v.skuId)).limit(1);
    if (!sku) throw new ApiError(404, "SKU 不存在");
    const [dup] = await tx.select({ id: schema.auditLogs.id }).from(schema.auditLogs).where(and(
      eq(schema.auditLogs.entity, "replenish"),
      eq(schema.auditLogs.action, "decline_suggestion"),
      eq(schema.auditLogs.entityId, sku.id),
      eq(schema.auditLogs.userId, user.id),
      sql`${schema.auditLogs.after}->>'businessDate' = ${businessDate}`,
    )).limit(1);
    if (dup) return { skuId: sku.id, skuCode: sku.code, businessDate, reasonCode: v.reasonCode, duplicate: true };
    await writeAudit(tx, {
      userId: user.id,
      entity: "replenish",
      entityId: sku.id,
      action: "decline_suggestion",
      after: { skuId: sku.id, skuCode: sku.code, businessDate, reasonCode: v.reasonCode, reason: v.reason, source: "replenish_suggestion" },
    });
    return { skuId: sku.id, skuCode: sku.code, businessDate, reasonCode: v.reasonCode, duplicate: false };
  });
}
