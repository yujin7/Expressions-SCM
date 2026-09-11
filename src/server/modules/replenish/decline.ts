/**
 * 「已复核并放弃」写路径（闭环审计 #12）：计划员看过某 SKU 的补货建议、判断不需要下单时留痕。
 *
 * 此前只有 draft_bh 有审计，放弃完全不可见——采纳率把"没看"与"看过不需要"混在一起。
 * 审计（entity=replenish, action=decline_suggestion, entityId=skuId）仍是留痕的权威，不改建议、不开单据（R13）。
 * 幂等：同人同 SKU 同业务日重复提交只保留第一条（after.businessDate 相同即视为重复）。
 * 读侧：report/closed-loop.ts 单列 declined 计数，不进采纳率分母。
 *
 * ── W2-#6：放弃现在会改变下一次运行 ──
 * 此前放弃只写审计，**下一轮照旧建议同一个 SKU**——计划员每天对同一条建议重复做同一个判断。
 * 现在同事务再落一条抑制窗口（replenish_suppressions），窗口长度按原因取
 * （`rules/replenish-suppression.ts`），到期即解除；`supply_already_arranged` 还会在
 * 供应事实一变时提前解除——到货入库（在库 ↑）、被登记为未结供给（全管道 ↑）、安排告吹（全管道 ↓），
 * 三者任一（C8）。
 * 抑制**绝不静默**：被抑制的行照常出现在补货列表里，标着原因与到期日，任何人可一键解除。
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { DECLINE_REASON_CODES, type DeclineReasonCode } from "@/lib/replenish-decline-reasons";
import { suppressionState, suppressionWindowFor } from "@/server/rules/replenish-suppression";
import { getOnHandBySku } from "@/server/core/stock-view";
import { getOpenSupplyLines } from "@/server/core/supply";

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
  /** W2-#6 本次建立/续期的抑制窗口（到期日与是否随到货解除） */
  suppression: { id: number; untilDate: string; days: number; releaseOnArrival: boolean; rationale: string } | null;
}

/**
 * 该 SKU 的**在库**与**全管道量**（在库 + 全部未结供给）——抑制提前解除的两条基线。
 * 两个数都取共享层唯一权威（core/stock-view / core/supply），不在这里另算一套。
 *
 * 为什么要两条（C8）：到货是「在库 ↑、未结供给 ↓、全管道量不变」，只存管道基线时
 * 「到货即解除」在数据上根本不可观测；而安排被取消是「管道量下降」，也只有对着基线才看得出来。
 */
export async function pipelineQtyOf(db: AnyDb, skuId: number): Promise<{ onHand: number; pipeline: number }> {
  const view = await getOnHandBySku(db, { skuIds: [skuId] });
  const onHand = Number(view.bySku.get(skuId) ?? "0");
  let supply = 0;
  for (const line of await getOpenSupplyLines(db, [skuId])) if (line.qty > 0) supply += line.qty;
  return { onHand, pipeline: onHand + supply };
}

export async function declineReplenishSuggestion(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<DeclineSuggestionResult> {
  requireAnyRole(user, "pmc");
  const v = declineSuggestionSchema.parse(input);
  const db = await resolveDb(dbArg);
  const businessDate = todayShanghai();
  // 两条基线必须在事务外先算好：getOnHandBySku / getOpenSupplyLines 是只读装配，放事务里只会拉长锁
  const baseline = await pipelineQtyOf(db, v.skuId);
  const window = suppressionWindowFor(v.reasonCode, businessDate);
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
    if (dup) return { skuId: sku.id, skuCode: sku.code, businessDate, reasonCode: v.reasonCode, duplicate: true, suppression: null };
    await writeAudit(tx, {
      userId: user.id,
      entity: "replenish",
      entityId: sku.id,
      action: "decline_suggestion",
      after: { skuId: sku.id, skuCode: sku.code, businessDate, reasonCode: v.reasonCode, reason: v.reason, source: "replenish_suggestion" },
    });

    /* W2-#6 抑制窗口：同一 SKU 同时最多一条有效（表上部分唯一索引），
       后一次放弃取代前一次（旧行写 cleared_at 留痕，不删）——否则唯一索引会把「改主意」判成冲突。 */
    const t = schema.replenishSuppressions;
    await tx
      .update(t)
      .set({ clearedBy: user.id, clearedAt: new Date(), clearNote: "被同一 SKU 的新放弃记录取代" })
      .where(and(eq(t.skuId, sku.id), isNull(t.clearedAt)));
    const [created] = await tx
      .insert(t)
      .values({
        skuId: sku.id,
        reasonCode: v.reasonCode,
        reason: v.reason,
        businessDate,
        untilDate: window.untilDate,
        releaseOnArrival: window.releaseOnArrival,
        pipelineBaseline: dQty(String(baseline.pipeline)),
        onHandBaseline: dQty(String(baseline.onHand)),
        createdBy: user.id,
      })
      .returning({ id: t.id });
    await writeAudit(tx, {
      userId: user.id,
      entity: "replenish_suppression",
      entityId: created.id,
      action: "create",
      after: {
        skuId: sku.id, skuCode: sku.code, reasonCode: v.reasonCode, businessDate,
        untilDate: window.untilDate, releaseOnArrival: window.releaseOnArrival,
        pipelineBaseline: baseline.pipeline, onHandBaseline: baseline.onHand,
      },
    });
    return {
      skuId: sku.id,
      skuCode: sku.code,
      businessDate,
      reasonCode: v.reasonCode,
      duplicate: false,
      suppression: { id: created.id, untilDate: window.untilDate, days: window.days, releaseOnArrival: window.releaseOnArrival, rationale: window.rationale },
    };
  });
}

/* ────────────────────────── W2-#6 抑制窗口读/清 ────────────────────────── */

export interface ActiveSuppressionRow {
  id: number;
  skuId: number;
  reasonCode: DeclineReasonCode;
  reason: string;
  businessDate: string;
  untilDate: string;
  releaseOnArrival: boolean;
  pipelineBaseline: number;
  /** 放弃当时的账面在库（C8：到货判定的基线，管道量看不出到货） */
  onHandBaseline: number;
  by: string;
  createdAt: string;
}

/**
 * 未清除且未到期的抑制行（按 SKU 索引）。
 * 「是否真的还在压」还要看 `releaseOnArrival` 的管道量比较——那要用到引擎已经装配好的管道量，
 * 故留给调用方（service）用 `suppressionState` 判定，这里只负责把候选行取回来。
 */
export async function loadActiveSuppressions(dbArg?: AnyDb, todayArg?: string, skuIds?: number[]): Promise<Map<number, ActiveSuppressionRow>> {
  const db = await resolveDb(dbArg);
  const today = todayArg ?? todayShanghai();
  const t = schema.replenishSuppressions;
  const conds = [isNull(t.clearedAt), sql`${t.untilDate} >= ${today}`];
  if (skuIds?.length) conds.push(inArray(t.skuId, [...new Set(skuIds)]));
  const rows: { id: number; skuId: number; reasonCode: string; reason: string; businessDate: string; untilDate: string; releaseOnArrival: boolean; pipelineBaseline: string; onHandBaseline: string; by: string | null; createdAt: Date }[] =
    await db
      .select({
        id: t.id, skuId: t.skuId, reasonCode: t.reasonCode, reason: t.reason, businessDate: t.businessDate,
        untilDate: t.untilDate, releaseOnArrival: t.releaseOnArrival, pipelineBaseline: t.pipelineBaseline,
        onHandBaseline: t.onHandBaseline,
        by: schema.users.name, createdAt: t.createdAt,
      })
      .from(t)
      .leftJoin(schema.users, eq(t.createdBy, schema.users.id))
      .where(and(...conds))
      .orderBy(desc(t.id));
  const out = new Map<number, ActiveSuppressionRow>();
  for (const r of rows) {
    if (out.has(r.skuId)) continue; // 同 SKU 只可能有一条有效行；取最新的做保险
    out.set(r.skuId, {
      id: r.id,
      skuId: r.skuId,
      reasonCode: DECLINE_REASON_CODES.includes(r.reasonCode as DeclineReasonCode) ? (r.reasonCode as DeclineReasonCode) : "other",
      reason: r.reason,
      businessDate: r.businessDate,
      untilDate: r.untilDate,
      releaseOnArrival: r.releaseOnArrival,
      pipelineBaseline: Number(r.pipelineBaseline),
      onHandBaseline: Number(r.onHandBaseline),
      by: r.by ?? "未知用户",
      createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    });
  }
  return out;
}

export const clearSuppressionSchema = z.object({
  id: z.number().int().positive({ message: "必须指定抑制记录" }),
  note: z.string().trim().max(200).optional(),
});

/** 人工解除抑制（pmc/admin）：写 cleared_at 留痕，不删行；下一次运行该 SKU 立刻恢复建议。 */
export async function clearReplenishSuppression(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<{ id: number; skuId: number }> {
  requireAnyRole(user, "pmc");
  const v = clearSuppressionSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const t = schema.replenishSuppressions;
    const [before] = await tx.select().from(t).where(eq(t.id, v.id)).limit(1);
    if (!before) throw new ApiError(404, "抑制记录不存在");
    if (before.clearedAt) throw new ApiError(409, "该抑制已解除");
    await tx.update(t).set({ clearedBy: user.id, clearedAt: new Date(), clearNote: v.note?.trim() || "人工解除" }).where(eq(t.id, v.id));
    await writeAudit(tx, {
      userId: user.id,
      entity: "replenish_suppression",
      entityId: v.id,
      action: "clear",
      before: { skuId: before.skuId, reasonCode: before.reasonCode, untilDate: before.untilDate },
      after: { clearNote: v.note?.trim() || "人工解除" },
    });
    return { id: v.id, skuId: before.skuId };
  });
}

export { suppressionState };

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
