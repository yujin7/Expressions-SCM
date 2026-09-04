/**
 * 「已复核并放弃」写路径（闭环审计 #12）：计划员看过某 SKU 的补货建议、判断不需要下单时留痕。
 *
 * 此前只有 draft_bh 有审计，放弃完全不可见——采纳率把"没看"与"看过不需要"混在一起。
 * 只写 audit_logs（entity=replenish, action=decline_suggestion, entityId=skuId），不建表、不改建议、不开单据（R13）。
 * 读侧：report/closed-loop.ts 单列 declined 计数，不进采纳率分母。
 * 幂等：同人同 SKU 同业务日重复提交只保留第一条（after.businessDate 相同即视为重复）。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { DECLINE_REASON_CODES, type DeclineReasonCode } from "@/lib/replenish-decline-reasons";

/** 原因码唯一定义在零依赖模块 `src/lib/replenish-decline-reasons.ts`（客户端表单可直接导入），这里再导出保持既有路径 */
export { DECLINE_REASON_CODES, type DeclineReasonCode };

export const declineSuggestionSchema = z.object({
  skuId: z.number().int().positive({ message: "必须选择 SKU" }),
  reason: z.string().trim().min(1, "必须填写放弃原因").max(500),
  reasonCode: z.enum(DECLINE_REASON_CODES).optional().default("other"),
});

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

/* ────────────────────────── 读侧：当日放弃状态（W5） ────────────────────────── */

/**
 * 当前业务日（Asia/Shanghai）已「复核并放弃」的 SKU——从审计台账读，服务端下发到建议行。
 *
 * 为什么必须走服务端：此前页面只把放弃状态存在 sessionStorage，于是**只有点的那个人、那台浏览器**看得见，
 * 换人换设备就看不到同事今天已经复核过——两个人对同一条建议各判一次，留痕两条、协作零。
 * 同一 SKU 当日多人放弃时取最近一条（审计仍全量保留）。
 */
export interface DeclinedTodayRow {
  skuId: number;
  by: string;
  userId: number;
  /** ISO 时间戳 */
  at: string;
  reason: string;
  reasonCode: DeclineReasonCode;
  businessDate: string;
}

export async function loadDeclinedToday(dbArg?: AnyDb, businessDateArg?: string): Promise<DeclinedTodayRow[]> {
  const db = await resolveDb(dbArg);
  const businessDate = businessDateArg ?? todayShanghai();
  const al = schema.auditLogs;
  const rows: { id: number; userId: number; after: unknown; createdAt: Date }[] = await db
    .select({ id: al.id, userId: al.userId, after: al.after, createdAt: al.createdAt })
    .from(al)
    .where(and(
      eq(al.entity, "replenish"),
      eq(al.action, "decline_suggestion"),
      sql`${al.after}->>'businessDate' = ${businessDate}`,
    ))
    .orderBy(al.id);
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((r) => r.userId).filter((v) => v != null))];
  const users: { id: number; name: string }[] = userIds.length
    ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  // id 升序遍历、后写覆盖前写 → 同 SKU 保留最近一条
  const bySku = new Map<number, DeclinedTodayRow>();
  for (const r of rows) {
    const after = (r.after ?? {}) as { skuId?: unknown; reason?: unknown; reasonCode?: unknown };
    const skuId = typeof after.skuId === "number" ? after.skuId : null;
    if (skuId == null) continue;
    const code = DECLINE_REASON_CODES.includes(after.reasonCode as DeclineReasonCode)
      ? (after.reasonCode as DeclineReasonCode)
      : "other";
    bySku.set(skuId, {
      skuId,
      userId: r.userId,
      by: nameById.get(r.userId) ?? `用户#${r.userId}`,
      at: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
      reason: typeof after.reason === "string" ? after.reason : "",
      reasonCode: code,
      businessDate,
    });
  }
  return [...bySku.values()];
}
