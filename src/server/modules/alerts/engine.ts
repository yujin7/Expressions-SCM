import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { resolveDb, type AnyDb } from "@/server/core/svc";

/**
 * 预警引擎（D56/D57；研究采纳：去重键、责任角色、动作链接、参数快照、迟滞自动关闭、人工已知悉）。
 *
 * - 幂等：同 category + dedupeKey 只保留一条 open 告警；再次命中只更新 last_hit_at / title / detail / severity。
 * - 迟滞关闭：本轮未命中的 open 告警，若 last_hit_at 距今 ≥ autoCloseAfterDays（缺省 3）才自动关闭（autoResolved=true）；
 *   期间仍命中则续命。这样一天的数据缺口不会把告警关掉又打开。
 * - 已知悉：人工 ackAlert 只记 acked_by/acked_at，不改 status（事实闭环仍由引擎判定），写审计。
 * - 系统告警属系统写入（沿用既有看门狗先例不写审计）；ackAlert 是业务写路径，必须 writeAudit。
 */
export interface AlertCandidate {
  refKey: string;
  dedupeKey: string;
  title: string;
  detail?: string | null;
  severity: "high" | "medium" | "critical";
  ownerRole?: string | null;
  actionHref?: string | null;
  sourceRule?: string | null;
  paramsSnapshot?: Record<string, unknown> | null;
}

export interface UpsertAlertsResult {
  opened: number;
  refreshed: number;
  autoClosed: number;
  stillOpen: number;
}

export async function upsertAlerts(
  dbArg: AnyDb,
  input: { category: string; candidates: AlertCandidate[]; now?: Date; autoCloseAfterDays?: number },
): Promise<UpsertAlertsResult> {
  const db = await resolveDb(dbArg);
  const now = input.now ?? new Date();
  const closeAfterMs = (input.autoCloseAfterDays ?? 3) * 24 * 60 * 60 * 1000;
  const open: { id: number; dedupeKey: string | null; lastHitAt: Date | null; createdAt: Date }[] = await db
    .select({ id: schema.systemAlerts.id, dedupeKey: schema.systemAlerts.dedupeKey, lastHitAt: schema.systemAlerts.lastHitAt, createdAt: schema.systemAlerts.createdAt })
    .from(schema.systemAlerts)
    .where(and(eq(schema.systemAlerts.category, input.category), eq(schema.systemAlerts.status, "open")));
  const openByKey = new Map(open.filter((o) => o.dedupeKey).map((o) => [o.dedupeKey as string, o]));

  let opened = 0, refreshed = 0;
  const hitKeys = new Set<string>();
  for (const c of input.candidates) {
    if (hitKeys.has(c.dedupeKey)) continue; // 同一轮内重复候选只算一次
    hitKeys.add(c.dedupeKey);
    const existing = openByKey.get(c.dedupeKey);
    if (existing) {
      await db.update(schema.systemAlerts).set({
        title: c.title, detail: c.detail ?? null, severity: c.severity, ownerRole: c.ownerRole ?? null,
        actionHref: c.actionHref ?? null, sourceRule: c.sourceRule ?? null, paramsSnapshot: c.paramsSnapshot ?? null, lastHitAt: now,
      }).where(eq(schema.systemAlerts.id, existing.id));
      refreshed++;
    } else {
      await db.insert(schema.systemAlerts).values({
        category: input.category, refKey: c.refKey, dedupeKey: c.dedupeKey, title: c.title, detail: c.detail ?? null,
        severity: c.severity, ownerRole: c.ownerRole ?? null, actionHref: c.actionHref ?? null, sourceRule: c.sourceRule ?? null,
        paramsSnapshot: c.paramsSnapshot ?? null, lastHitAt: now,
      });
      opened++;
    }
  }

  // 迟滞自动关闭
  const toClose = open
    .filter((o) => !o.dedupeKey || !hitKeys.has(o.dedupeKey))
    .filter((o) => now.getTime() - new Date(o.lastHitAt ?? o.createdAt).getTime() >= closeAfterMs)
    .map((o) => o.id);
  if (toClose.length) {
    await db.update(schema.systemAlerts).set({ status: "resolved", autoResolved: true, resolvedAt: now })
      .where(inArray(schema.systemAlerts.id, toClose));
  }
  const [still] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.systemAlerts)
    .where(and(eq(schema.systemAlerts.category, input.category), eq(schema.systemAlerts.status, "open")));
  return { opened, refreshed, autoClosed: toClose.length, stillOpen: Number(still?.n ?? 0) };
}

/** 人工「已知悉」：写 acked_by/acked_at + 审计；status 不变（事实闭环归引擎） */
export async function ackAlert(actor: SessionUser, alertId: number, dbArg?: AnyDb, note?: string): Promise<{ id: number; ackedAt: string }> {
  const db = await resolveDb(dbArg);
  if (!Number.isInteger(alertId) || alertId <= 0) throw new ApiError(400, "告警 id 非法");
  return db.transaction(async (tx: AnyDb) => {
    const [row] = await tx.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, alertId)).limit(1);
    if (!row) throw new ApiError(404, "告警不存在");
    if (row.status !== "open") throw new ApiError(409, "告警已关闭，无需知悉");
    const now = new Date();
    await tx.update(schema.systemAlerts).set({ ackedBy: actor.id, ackedAt: now }).where(eq(schema.systemAlerts.id, alertId));
    await writeAudit(tx, {
      userId: actor.id, entity: "system_alert", entityId: alertId, action: "ack",
      before: { ackedBy: row.ackedBy, ackedAt: row.ackedAt }, after: { ackedBy: actor.id, ackedAt: now.toISOString(), note: note ?? null },
    });
    return { id: alertId, ackedAt: now.toISOString() };
  });
}

/** 计数：open 且（可选）未知悉 */
export async function countOpenAlerts(dbArg: AnyDb, category: string): Promise<{ open: number; unacked: number }> {
  const db = await resolveDb(dbArg);
  const [row] = await db.select({
    open: sql<number>`count(*)::int`,
    unacked: sql<number>`count(*) filter (where ${schema.systemAlerts.ackedAt} is null)::int`,
  }).from(schema.systemAlerts).where(and(eq(schema.systemAlerts.category, category), eq(schema.systemAlerts.status, "open")));
  return { open: Number(row?.open ?? 0), unacked: Number(row?.unacked ?? 0) };
}
