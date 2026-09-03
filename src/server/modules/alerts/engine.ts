import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ackResetOnRehit } from "@/server/rules/alert-ack";

/**
 * 预警引擎（D56/D57；研究采纳：去重键、责任角色、动作链接、参数快照、迟滞自动关闭、人工已知悉）。
 *
 * - 幂等：同 category + dedupeKey 只保留一条 open 告警；再次命中只更新 last_hit_at / title / detail / severity。
 * - 迟滞关闭：本轮未命中的 open 告警，若 last_hit_at 距今 ≥ autoCloseAfterDays（缺省 3）才自动关闭（autoResolved=true）；
 *   期间仍命中则续命。这样一天的数据缺口不会把告警关掉又打开。
 * - 已知悉：人工 ackAlert 只记 acked_by/acked_at，不改 status（事实闭环仍由引擎判定），写审计。
 *   再命中时按 rules/alert-ack 决定是否清知悉（严重度升级 / 知悉 ≥ 7 天仍命中）——审计 A3(2)。
 * - 解释载荷（审计 #4）：候选可带 why[]（label/value/source），引擎原样落进 paramsSnapshot.why——
 *   与 sourceRule/paramsSnapshot 同行持久化，页面按自身授权展示；通知正文不带。
 * - 人工关闭抑制（审计 #10）：suppressManuallyClosedDays 指定时，同 dedupeKey 在 N 天内被人工关闭
 *   （autoResolved=false）的不重开（条件在窗口内恒成立的告警类别用，如 transfer_cost）。
 * - 系统告警属系统写入（沿用既有看门狗先例不写审计）；ackAlert 是业务写路径，必须 writeAudit。
 * - 事件台账（闭环审计 #2）：open / refresh(每上海日一条) / close(auto_hysteresis) 由引擎追加到 alert_events；
 *   ack / close(人工原因) 与审计同事务追加。台账只追加（触发器），幂等键防重复落账；引擎不因台账失败回滚告警状态以外的任何事。
 */
export interface AlertWhy {
  label: string;
  value: string;
  source: string;
}

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
  /** 解释载荷：为什么触发（落 paramsSnapshot.why） */
  why?: AlertWhy[] | null;
}

export interface UpsertAlertsResult {
  opened: number;
  refreshed: number;
  autoClosed: number;
  stillOpen: number;
  /** 因人工关闭抑制而未开（仅 suppressManuallyClosedDays 生效时计） */
  suppressed: number;
  /** 再命中时清掉的已知悉数 */
  ackReset: number;
}

/** paramsSnapshot 与 why 合并：why 非空才写入 .why */
function snapshotWith(c: AlertCandidate): Record<string, unknown> | null {
  const base = c.paramsSnapshot ?? null;
  if (!c.why || !c.why.length) return base;
  return { ...(base ?? {}), why: c.why };
}

/** alert_events 追加行（幂等键唯一；重复键静默跳过——同一轮/同一日重复落账不是错误） */
export interface AlertEventInput {
  alertId: number;
  event: schema.AlertEventKind;
  at: Date;
  actorId?: number | null;
  reasonCode?: schema.AlertCloseReasonCode | null;
  note?: string | null;
  evidenceRef?: Record<string, unknown> | null;
  idempotencyKey: string;
}

const SH_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
export function alertEventDay(d: Date): string {
  return SH_DAY.format(d);
}

/** 追加告警事件（只追加表；ON CONFLICT (idempotency_key) DO NOTHING）。返回实际落账条数。 */
export async function appendAlertEvents(db: AnyDb, rows: readonly AlertEventInput[]): Promise<number> {
  if (!rows.length) return 0;
  const inserted: { id: number }[] = await db.insert(schema.alertEvents).values(rows.map((r) => ({
    alertId: r.alertId, event: r.event, at: r.at, actorId: r.actorId ?? null, reasonCode: r.reasonCode ?? null,
    note: r.note ?? null, evidenceRef: r.evidenceRef ?? null, idempotencyKey: r.idempotencyKey,
  }))).onConflictDoNothing({ target: schema.alertEvents.idempotencyKey }).returning({ id: schema.alertEvents.id });
  return inserted.length;
}

export async function upsertAlerts(
  dbArg: AnyDb,
  input: {
    category: string;
    candidates: AlertCandidate[];
    now?: Date;
    autoCloseAfterDays?: number;
    /** 同 dedupeKey 在 N 天内被人工关闭（autoResolved=false）则不重开；缺省不抑制 */
    suppressManuallyClosedDays?: number;
    /** 已知悉再命中多少天后清知悉（rules/alert-ack，缺省 7） */
    ackResetAfterDays?: number;
  },
): Promise<UpsertAlertsResult> {
  const db = await resolveDb(dbArg);
  const now = input.now ?? new Date();
  const closeAfterMs = (input.autoCloseAfterDays ?? 3) * 24 * 60 * 60 * 1000;
  const open: { id: number; dedupeKey: string | null; lastHitAt: Date | null; createdAt: Date; severity: string | null; ackedAt: Date | null }[] = await db
    .select({
      id: schema.systemAlerts.id, dedupeKey: schema.systemAlerts.dedupeKey, lastHitAt: schema.systemAlerts.lastHitAt,
      createdAt: schema.systemAlerts.createdAt, severity: schema.systemAlerts.severity, ackedAt: schema.systemAlerts.ackedAt,
    })
    .from(schema.systemAlerts)
    .where(and(eq(schema.systemAlerts.category, input.category), eq(schema.systemAlerts.status, "open")));
  const openByKey = new Map(open.filter((o) => o.dedupeKey).map((o) => [o.dedupeKey as string, o]));

  // 人工关闭抑制：窗口内被人关掉的同键不重开（条件恒成立的类别否则每次 cron 都重开）
  const suppressDays = input.suppressManuallyClosedDays;
  const manuallyClosed = new Set<string>();
  if (suppressDays != null && suppressDays > 0) {
    const since = new Date(now.getTime() - suppressDays * 24 * 60 * 60 * 1000);
    const rows: { dedupeKey: string | null }[] = await db
      .select({ dedupeKey: schema.systemAlerts.dedupeKey })
      .from(schema.systemAlerts)
      .where(and(
        eq(schema.systemAlerts.category, input.category), eq(schema.systemAlerts.status, "resolved"),
        eq(schema.systemAlerts.autoResolved, false), sql`${schema.systemAlerts.resolvedAt} >= ${since.toISOString()}::timestamptz`,
      ));
    for (const r of rows) if (r.dedupeKey) manuallyClosed.add(r.dedupeKey);
  }

  let opened = 0, refreshed = 0, suppressed = 0, ackReset = 0;
  const hitKeys = new Set<string>();
  const events: AlertEventInput[] = [];
  const day = alertEventDay(now);
  for (const c of input.candidates) {
    if (hitKeys.has(c.dedupeKey)) continue; // 同一轮内重复候选只算一次
    hitKeys.add(c.dedupeKey);
    const existing = openByKey.get(c.dedupeKey);
    if (existing) {
      const ack = ackResetOnRehit({ ackedAt: existing.ackedAt, prevSeverity: existing.severity, nextSeverity: c.severity, now, resetAfterDays: input.ackResetAfterDays });
      await db.update(schema.systemAlerts).set({
        title: c.title, detail: c.detail ?? null, severity: c.severity, ownerRole: c.ownerRole ?? null,
        actionHref: c.actionHref ?? null, sourceRule: c.sourceRule ?? null, paramsSnapshot: snapshotWith(c), lastHitAt: now,
        ...(ack.reset ? { ackedAt: null, ackedBy: null } : {}),
      }).where(eq(schema.systemAlerts.id, existing.id));
      refreshed++;
      if (ack.reset) ackReset++;
      events.push({ alertId: existing.id, event: "refresh", at: now, idempotencyKey: `${existing.id}:refresh:${day}` });
    } else {
      if (manuallyClosed.has(c.dedupeKey)) { suppressed++; continue; } // 人工已处理，窗口内不重开
      // 部分唯一索引 uq_alert_open_dedupe(category, dedupe_key) WHERE status='open'：
      // 与另一并发运行撞上时不插入（对方已开同键告警），按"已刷新"计数而不是双开。
      const ins: { id: number }[] = await db.insert(schema.systemAlerts).values({
        category: input.category, refKey: c.refKey, dedupeKey: c.dedupeKey, title: c.title, detail: c.detail ?? null,
        severity: c.severity, ownerRole: c.ownerRole ?? null, actionHref: c.actionHref ?? null, sourceRule: c.sourceRule ?? null,
        paramsSnapshot: snapshotWith(c), lastHitAt: now,
      }).onConflictDoNothing({ target: [schema.systemAlerts.category, schema.systemAlerts.dedupeKey], where: sql`${schema.systemAlerts.status} = 'open'` })
        .returning({ id: schema.systemAlerts.id });
      if (ins.length) {
        opened++;
        events.push({ alertId: ins[0].id, event: "open", at: now, idempotencyKey: `${ins[0].id}:open` });
      } else {
        refreshed++; // 并发对方已开同键告警：本轮不知其 id，事件由对方那轮落账
      }
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
    for (const id of toClose) {
      events.push({
        alertId: id, event: "close", at: now, reasonCode: "auto_hysteresis",
        note: `连续 ${input.autoCloseAfterDays ?? 3} 天未命中，引擎迟滞关闭`,
        idempotencyKey: `${id}:close:${now.toISOString()}`,
      });
    }
  }
  await appendAlertEvents(db, events);
  const [still] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.systemAlerts)
    .where(and(eq(schema.systemAlerts.category, input.category), eq(schema.systemAlerts.status, "open")));
  return { opened, refreshed, autoClosed: toClose.length, stillOpen: Number(still?.n ?? 0), suppressed, ackReset };
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
    await appendAlertEvents(tx, [{
      alertId, event: "ack", at: now, actorId: actor.id, note: note ?? null, idempotencyKey: `${alertId}:ack:${now.toISOString()}`,
    }]);
    return { id: alertId, ackedAt: now.toISOString() };
  });
}

export type ManualCloseReasonCode = (typeof schema.MANUAL_CLOSE_REASON_CODES)[number];

/**
 * 人工关闭告警（闭环审计 #2）：status→resolved、autoResolved=false、resolvedAt=now；
 * 同事务写审计（action=close）与 alert_events(close, reason_code)。
 * 权限：告警 ownerRole 对应角色或 admin（ownerRole 为空的历史告警只允许 admin）。
 * reasonCode 只接受人工原因（fixed / false_positive / wont_fix / superseded / manual）；auto_hysteresis 保留给引擎。
 * 关闭不删除告警、不阻止引擎下轮再次开新告警（同键新开是新事实，不是 reopen）。
 */
export async function closeAlert(
  actor: SessionUser,
  alertId: number,
  reasonCode: string,
  note?: string | null,
  dbArg?: AnyDb,
  opts?: { now?: Date },
): Promise<{ id: number; resolvedAt: string; reasonCode: ManualCloseReasonCode }> {
  const db = await resolveDb(dbArg);
  if (!Number.isInteger(alertId) || alertId <= 0) throw new ApiError(400, "告警 id 非法");
  if (!(schema.MANUAL_CLOSE_REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new ApiError(400, `关闭原因非法：只接受 ${schema.MANUAL_CLOSE_REASON_CODES.join(" / ")}`);
  }
  const reason = reasonCode as ManualCloseReasonCode;
  const trimmedNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  return db.transaction(async (tx: AnyDb) => {
    const [row] = await tx.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, alertId)).limit(1);
    if (!row) throw new ApiError(404, "告警不存在");
    const isAdmin = actor.roles.includes("admin");
    const isOwner = row.ownerRole != null && actor.roles.includes(row.ownerRole);
    if (!isAdmin && !isOwner) throw new ApiError(403, `无权限关闭此告警：需要 ${row.ownerRole ?? "admin"} 角色`);
    if (row.status !== "open") throw new ApiError(409, "告警已关闭");
    const now = opts?.now ?? new Date();
    await tx.update(schema.systemAlerts).set({ status: "resolved", autoResolved: false, resolvedAt: now })
      .where(and(eq(schema.systemAlerts.id, alertId), eq(schema.systemAlerts.status, "open")));
    await writeAudit(tx, {
      userId: actor.id, entity: "system_alert", entityId: alertId, action: "close",
      before: { status: row.status, autoResolved: row.autoResolved, resolvedAt: row.resolvedAt },
      after: { status: "resolved", autoResolved: false, resolvedAt: now.toISOString(), reasonCode: reason, note: trimmedNote },
    });
    await appendAlertEvents(tx, [{
      alertId, event: "close", at: now, actorId: actor.id, reasonCode: reason, note: trimmedNote,
      idempotencyKey: `${alertId}:close:${now.toISOString()}`,
    }]);
    return { id: alertId, resolvedAt: now.toISOString(), reasonCode: reason };
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
