/**
 * 例外「打盹 / 忽略」与出现天数记忆（路线图 W9）。
 *
 * 控制塔的例外此前每次进页面现算、**没有任何记忆**：一条已经知会过的例外压不下去，
 * 也没人答得出"这条连续出现 40 天、从来没人点过"。本模块补上这份记忆（表 exception_dismissals）：
 *  - `snoozeException`：按上海日打盹到某天（含当天仍隐藏）+ 必填原因备注 → 同事务写审计；
 *  - `clearExceptionSnooze`：提前恢复显示 → 同事务写审计；
 *  - `recordExceptionsShown`：算出例外时推进"连续出现天数"（一次批量 upsert，按上海日幂等）；
 *  - `loadExceptionMemory`：读打盹状态与连续天数，供 computeExceptions 过滤与标注。
 *
 * 纪律：
 *  - **打盹是全局的**（控制塔是全员同一块板，不是个人收件箱）：因此它是业务写路径，
 *    必须回查会话（路由用 getFreshSessionUser）并在同一事务写 audit_logs；
 *  - 只影响展示：不改告警状态、不动待办、不参与任何记账；
 *  - 例外键只接受 `EXCEPTION_KEYS` 白名单——computeExceptions 之外的键写进来只会变成
 *    永远不会被消费的垃圾行（"能存进去"不等于"有意义"）；
 *  - 打盹上限 `MAX_SNOOZE_DAYS` 天：无限期打盹等于删除，那不是打盹是掩埋。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";

/**
 * 控制塔例外键白名单（与 workbench/focus.computeExceptions 产出的 key 一一对应）。
 * 新增例外时必须同步登记，否则该例外无法打盹、也不会有连续天数
 * （护栏：tests/workbench/exception-dismissals.test.ts）。
 */
export const EXCEPTION_KEYS = [
  "expired_stock",
  "doc_aging",
  "sales_spike",
  "inventory_cover",
  "stale_data",
  "below_lead",
  "missing_lead",
] as const;
export type ExceptionKey = (typeof EXCEPTION_KEYS)[number];

/** 打盹最长天数：再长就不是"稍后处理"而是"永久掩埋" */
export const MAX_SNOOZE_DAYS = 90;

const SH_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
/** 上海日（YYYY-MM-DD） */
export function shanghaiDay(d: Date = new Date()): string {
  return SH_DAY.format(d);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface ExceptionMemoryRow {
  exceptionKey: string;
  snoozedUntil: string | null;
  snoozeNote: string | null;
  snoozedByName: string | null;
  /** 连续出现天数（含最近一次展示日；从未展示 = 0） */
  consecutiveDays: number;
  lastShownOn: string | null;
}

/** 读全部例外记忆（行很少——键是有限白名单，不分页） */
export async function loadExceptionMemory(dbArg: AnyDb): Promise<Map<string, ExceptionMemoryRow>> {
  const db = await resolveDb(dbArg);
  const rows: {
    exceptionKey: string; snoozedUntil: string | null; snoozeNote: string | null;
    snoozedByName: string | null; consecutiveDays: number | null; lastShownOn: string | null;
  }[] = await db
    .select({
      exceptionKey: schema.exceptionDismissals.exceptionKey,
      snoozedUntil: schema.exceptionDismissals.snoozedUntil,
      snoozeNote: schema.exceptionDismissals.snoozeNote,
      snoozedByName: schema.users.name,
      consecutiveDays: schema.exceptionDismissals.consecutiveDays,
      lastShownOn: schema.exceptionDismissals.lastShownOn,
    })
    .from(schema.exceptionDismissals)
    .leftJoin(schema.users, eq(schema.exceptionDismissals.snoozedBy, schema.users.id));
  return new Map(rows.map((r) => [r.exceptionKey, {
    exceptionKey: r.exceptionKey,
    snoozedUntil: r.snoozedUntil ?? null,
    snoozeNote: r.snoozeNote ?? null,
    snoozedByName: r.snoozedByName ?? null,
    consecutiveDays: Number(r.consecutiveDays ?? 0),
    lastShownOn: r.lastShownOn ?? null,
  }]));
}

/** 打盹是否仍在生效（含到期当日）——单一判定处，页面与服务端不各写一遍 */
export function isSnoozed(row: ExceptionMemoryRow | undefined, today: string): boolean {
  return !!row?.snoozedUntil && row.snoozedUntil >= today;
}

/**
 * 推进「连续出现天数」：today 已记过 → 不动；紧接昨天 → +1；断过 → 从 1 重新起算。
 * 一条 INSERT … ON CONFLICT 批量完成（首屏路径上只多一次往返）；调用方吞异常，
 * 记不上账不该让工作台 500——记忆是增益，不是首屏的前置条件。
 */
export async function recordExceptionsShown(dbArg: AnyDb, keys: readonly string[], today: string): Promise<number> {
  const wanted = keys.filter((k) => (EXCEPTION_KEYS as readonly string[]).includes(k));
  if (!wanted.length) return 0;
  const db = await resolveDb(dbArg);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const values = sql.join(
    wanted.map((k) => sql`(${k}, ${today}::date, ${today}::date, 1)`),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO exception_dismissals (exception_key, first_shown_on, last_shown_on, consecutive_days)
    VALUES ${values}
    ON CONFLICT (exception_key) DO UPDATE SET
      consecutive_days = CASE
        WHEN exception_dismissals.last_shown_on = ${today}::date THEN exception_dismissals.consecutive_days
        WHEN exception_dismissals.last_shown_on = ${yesterday}::date THEN exception_dismissals.consecutive_days + 1
        ELSE 1 END,
      first_shown_on = CASE
        WHEN exception_dismissals.last_shown_on IN (${today}::date, ${yesterday}::date)
          THEN coalesce(exception_dismissals.first_shown_on, ${today}::date)
        ELSE ${today}::date END,
      last_shown_on = ${today}::date,
      updated_at = now()`);
  return wanted.length;
}

export interface SnoozeResult {
  exceptionKey: string;
  snoozedUntil: string;
  note: string;
}

/**
 * 打盹一个例外到 `until`（含当日）。写路径：调用方必须已回查会话（getFreshSessionUser）。
 * 备注必填——"为什么压下去"不写清楚，到期恢复时没人记得当初的判断。
 */
export async function snoozeException(
  actor: SessionUser,
  input: { exceptionKey: string; until: string; note: string },
  dbArg?: AnyDb,
  opts?: { today?: string },
): Promise<SnoozeResult> {
  const db = await resolveDb(dbArg);
  const key = String(input.exceptionKey ?? "").trim();
  if (!(EXCEPTION_KEYS as readonly string[]).includes(key)) throw new ApiError(400, `未知例外键：${key || "(空)"}`);
  const until = String(input.until ?? "").trim();
  if (!DATE_RE.test(until)) throw new ApiError(400, "打盹到期日格式应为 YYYY-MM-DD");
  const today = opts?.today ?? shanghaiDay();
  if (until < today) throw new ApiError(400, "打盹到期日不能早于今天");
  const span = dayDiff(today, until);
  if (span > MAX_SNOOZE_DAYS) throw new ApiError(400, `打盹最长 ${MAX_SNOOZE_DAYS} 天（无限期打盹等于掩埋问题）`);
  const note = String(input.note ?? "").trim();
  if (!note) throw new ApiError(400, "请填写打盹原因（到期恢复时要能看懂当初的判断）");
  const trimmedNote = note.slice(0, 500);

  return db.transaction(async (tx: AnyDb) => {
    const [before] = await tx.select().from(schema.exceptionDismissals)
      .where(eq(schema.exceptionDismissals.exceptionKey, key)).limit(1);
    const now = new Date();
    if (before) {
      await tx.update(schema.exceptionDismissals).set({
        snoozedUntil: until, snoozeNote: trimmedNote, snoozedBy: actor.id, snoozedAt: now, updatedAt: now,
      }).where(eq(schema.exceptionDismissals.id, before.id));
    } else {
      await tx.insert(schema.exceptionDismissals).values({
        exceptionKey: key, snoozedUntil: until, snoozeNote: trimmedNote, snoozedBy: actor.id, snoozedAt: now,
      });
    }
    const [after] = await tx.select().from(schema.exceptionDismissals)
      .where(eq(schema.exceptionDismissals.exceptionKey, key)).limit(1);
    await writeAudit(tx, {
      userId: actor.id, entity: "workbench_exception", entityId: after?.id ?? null, action: "snooze",
      before: before ? { snoozedUntil: before.snoozedUntil, snoozeNote: before.snoozeNote } : null,
      after: { exceptionKey: key, snoozedUntil: until, note: trimmedNote, consecutiveDaysAtSnooze: Number(before?.consecutiveDays ?? 0) },
    });
    return { exceptionKey: key, snoozedUntil: until, note: trimmedNote };
  });
}

/** 提前恢复显示（清打盹）；同事务写审计。未打盹的键调用是幂等 no-op（不报错，但也不写审计）。 */
export async function clearExceptionSnooze(
  actor: SessionUser,
  exceptionKey: string,
  dbArg?: AnyDb,
): Promise<{ exceptionKey: string; cleared: boolean }> {
  const db = await resolveDb(dbArg);
  const key = String(exceptionKey ?? "").trim();
  if (!(EXCEPTION_KEYS as readonly string[]).includes(key)) throw new ApiError(400, `未知例外键：${key || "(空)"}`);
  return db.transaction(async (tx: AnyDb) => {
    const [before] = await tx.select().from(schema.exceptionDismissals)
      .where(and(eq(schema.exceptionDismissals.exceptionKey, key))).limit(1);
    if (!before?.snoozedUntil) return { exceptionKey: key, cleared: false };
    await tx.update(schema.exceptionDismissals).set({
      snoozedUntil: null, snoozeNote: null, snoozedBy: null, snoozedAt: null, updatedAt: new Date(),
    }).where(eq(schema.exceptionDismissals.id, before.id));
    await writeAudit(tx, {
      userId: actor.id, entity: "workbench_exception", entityId: before.id, action: "snooze_clear",
      before: { snoozedUntil: before.snoozedUntil, snoozeNote: before.snoozeNote },
      after: { exceptionKey: key, snoozedUntil: null },
    });
    return { exceptionKey: key, cleared: true };
  });
}

/** 当前仍在打盹的键（供健康面板/测试直接问，不必自己算日期比较） */
export async function snoozedKeys(dbArg: AnyDb, today: string): Promise<string[]> {
  const db = await resolveDb(dbArg);
  const rows: { exceptionKey: string }[] = await db
    .select({ exceptionKey: schema.exceptionDismissals.exceptionKey })
    .from(schema.exceptionDismissals)
    .where(and(
      inArray(schema.exceptionDismissals.exceptionKey, [...EXCEPTION_KEYS]),
      sql`${schema.exceptionDismissals.snoozedUntil} >= ${today}::date`,
    ));
  return rows.map((r) => r.exceptionKey).sort();
}
