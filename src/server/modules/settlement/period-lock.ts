/**
 * 会计期间锁（W2-1）——「已关账」的唯一权威。
 *
 * 修的是什么：`month-close.ts` 此前用 `month < 当前月` 推断 `periodClosed`。
 * 那只是日历，不是控制：签认完成的 7 月，8 月照样可以往里过账，账一变就再也对不回去。
 *
 * 边界：
 * - 本模块只回答「某期间此刻锁没锁」，并提供关账/重开两个写路径（均在同一事务写审计）；
 * - 强制点在过账路径 `src/server/posting/post.ts`（库存唯一合法入口），不是在页面上；
 * - 红字冲销**不豁免**：业务时间落在已锁期间的冲销同样被拒（下方 `isPeriodClosed` 无 action 参数，
 *   过账引擎也不给 reverse 开后门）。纠错的正确做法是——冲销单按当前开放期间过账（默认行为，
 *   occurredAt=now），或由管理员先重开期间再冲销。理由：允许冲销穿透期间锁，等于允许
 *   任何人给已签认月份加一笔负数流水，锁就只剩装饰作用。
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { periodLocks, users } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { shanghaiDayOf } from "@/server/core/business-day";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, resolveDb } from "@/server/core/svc";

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 任意时刻 → Asia/Shanghai 会计期间 YYYY-MM（日界与 core/business-day 同源） */
export function periodOf(at: Date): string {
  return shanghaiDayOf(at).slice(0, 7);
}

export function assertPeriodFormat(period: string): string {
  const p = String(period ?? "").trim();
  if (!PERIOD_RE.test(p)) throw new ApiError(400, "期间格式须为 YYYY-MM");
  return p;
}

export interface PeriodLockRow {
  period: string;
  closedAt: Date;
  closedByName: string | null;
  closeNote: string | null;
}

/**
 * 该期间是否已锁定。过账路径逐事件调用，因此只查一行、不做联表。
 * `reopened_at IS NULL` = 锁生效中；重开过的行视为未锁定。
 */
export async function isPeriodClosed(db: AnyDb, period: string): Promise<boolean> {
  const rows: { id: number }[] = await db
    .select({ id: periodLocks.id })
    .from(periodLocks)
    .where(and(eq(periodLocks.period, period), isNull(periodLocks.reopenedAt)))
    .limit(1);
  return rows.length > 0;
}

/** 已锁定期间清单（最新在前），供月结页与管理页展示 */
export async function listClosedPeriods(dbArg?: AnyDb): Promise<PeriodLockRow[]> {
  const db = await resolveDb(dbArg);
  const rows: PeriodLockRow[] = await db
    .select({
      period: periodLocks.period,
      closedAt: periodLocks.closedAt,
      closedByName: users.name,
      closeNote: periodLocks.closeNote,
    })
    .from(periodLocks)
    .leftJoin(users, eq(periodLocks.closedBy, users.id))
    .where(isNull(periodLocks.reopenedAt))
    .orderBy(sql`${periodLocks.period} desc`);
  return rows;
}

/** 单期间锁状态（含重开痕迹），供月结页头部展示 */
export async function getPeriodLock(
  period: string,
  dbArg?: AnyDb,
): Promise<{
  period: string;
  closed: boolean;
  closedAt: Date | null;
  closedByName: string | null;
  closeNote: string | null;
  reopenedAt: Date | null;
  reopenReason: string | null;
}> {
  const db = await resolveDb(dbArg);
  const p = assertPeriodFormat(period);
  const [row] = await db
    .select({
      period: periodLocks.period,
      closedAt: periodLocks.closedAt,
      closedByName: users.name,
      closeNote: periodLocks.closeNote,
      reopenedAt: periodLocks.reopenedAt,
      reopenReason: periodLocks.reopenReason,
    })
    .from(periodLocks)
    .leftJoin(users, eq(periodLocks.closedBy, users.id))
    .where(eq(periodLocks.period, p));
  return {
    period: p,
    closed: Boolean(row) && row.reopenedAt == null,
    closedAt: row?.closedAt ?? null,
    closedByName: row?.closedByName ?? null,
    closeNote: row?.closeNote ?? null,
    reopenedAt: row?.reopenedAt ?? null,
    reopenReason: row?.reopenReason ?? null,
  };
}

/**
 * 关账（财务）。前置：六项月结检查全部收口（completed/waived 且证据未变）——
 * 否则「关账」又变成一个与证据无关的按钮。
 */
export async function closePeriod(
  user: SessionUser,
  input: { period: string; note?: string | null },
  dbArg?: AnyDb,
  now = new Date(),
): Promise<{ period: string; closed: true }> {
  const { requireAnyRole } = await import("@/server/modules/outsource/common");
  requireAnyRole(user, "finance");
  const period = assertPeriodFormat(input.period);
  const db = await resolveDb(dbArg);
  if (period >= periodOf(now)) throw new ApiError(409, "当前月及未来月份不可关账");

  const { getMonthCloseChecklist } = await import("@/server/modules/settlement/month-close");
  const checklist = await getMonthCloseChecklist(period, db, now);
  const outstanding = checklist.checks.filter((c) => !c.current);
  if (outstanding.length > 0) {
    throw new ApiError(
      409,
      `以下月结检查项尚未收口，不能关账：${outstanding.map((c) => c.title).join("、")}`,
    );
  }

  const note = (input.note ?? "").trim() || null;
  await db.transaction(async (tx: AnyDb) => {
    const [existing] = await tx.select().from(periodLocks).where(eq(periodLocks.period, period));
    if (existing && existing.reopenedAt == null) throw new ApiError(409, `期间 ${period} 已关账`);
    let id: number;
    if (existing) {
      const [row] = await tx
        .update(periodLocks)
        .set({
          closedBy: user.id,
          closedAt: now,
          closeNote: note,
          reopenedBy: null,
          reopenedAt: null,
          reopenReason: null,
        })
        .where(and(eq(periodLocks.id, existing.id), sql`${periodLocks.reopenedAt} is not null`))
        .returning({ id: periodLocks.id });
      if (!row) throw new ApiError(409, `期间 ${period} 已关账`);
      id = row.id;
    } else {
      const [row] = await tx
        .insert(periodLocks)
        .values({ period, closedBy: user.id, closedAt: now, closeNote: note })
        .onConflictDoNothing({ target: periodLocks.period })
        .returning({ id: periodLocks.id });
      if (!row) throw new ApiError(409, `期间 ${period} 已关账`);
      id = row.id;
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "period_lock",
      entityId: id,
      action: "period_close",
      after: { period, note, reclosed: Boolean(existing) },
    });
  });
  return { period, closed: true };
}

/** 重开（仅管理员，必须留原因；同一事务写审计） */
export async function reopenPeriod(
  user: SessionUser,
  input: { period: string; reason: string },
  dbArg?: AnyDb,
  now = new Date(),
): Promise<{ period: string; closed: false }> {
  if (!user.roles.includes("admin")) throw new ApiError(403, "仅管理员可重开会计期间");
  const period = assertPeriodFormat(input.period);
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 5) throw new ApiError(400, "重开期间须填写至少 5 个字符的原因");
  const db = await resolveDb(dbArg);
  await db.transaction(async (tx: AnyDb) => {
    const [existing] = await tx.select().from(periodLocks).where(eq(periodLocks.period, period));
    if (!existing || existing.reopenedAt != null) throw new ApiError(409, `期间 ${period} 未处于关账状态`);
    const [row] = await tx
      .update(periodLocks)
      .set({ reopenedBy: user.id, reopenedAt: now, reopenReason: reason })
      .where(and(eq(periodLocks.id, existing.id), isNull(periodLocks.reopenedAt)))
      .returning({ id: periodLocks.id });
    if (!row) throw new ApiError(409, `期间 ${period} 未处于关账状态`);
    await writeAudit(tx, {
      userId: user.id,
      entity: "period_lock",
      entityId: row.id,
      action: "period_reopen",
      before: { period, closedAt: existing.closedAt, closedBy: existing.closedBy },
      after: { period, reason },
    });
  });
  return { period, closed: false };
}
