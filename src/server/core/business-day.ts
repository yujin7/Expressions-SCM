/**
 * 业务日（Asia/Shanghai）唯一权威 —— 零依赖纯模块。
 *
 * 为什么要收口：日界换算曾在 `alerts/engine.ts`、`workbench/exception-dismissals.ts`、
 * `report/closed-loop.ts`、`jobs/alert-watchdogs.ts` 各写一份
 * `new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })`，
 * 日差换算也在三处各写一份 `dayDiff` / `daysBetween`。四份实现今天恰好一致，
 * 但没有任何东西保证它们一起改——口径漂移就是这么开始的（CLAUDE.md「共享层唯一权威」）。
 *
 * 本模块**不得**引入任何 import：它被 rules/（纯函数层）、server/modules、src/jobs
 * 同时引用，任何依赖都会顺着这三条线扩散。
 */

const SHANGHAI_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type DateLike = Date | string | null | undefined;

/** 已知有效的时刻 → Asia/Shanghai 业务日 YYYY-MM-DD（en-CA 输出即为该格式） */
export function shanghaiDayOf(d: Date): string {
  return SHANGHAI_FMT.format(d);
}

/** 今天的业务日（Asia/Shanghai） */
export function todayShanghai(): string {
  return shanghaiDayOf(new Date());
}

/** 任意时间 → Asia/Shanghai 业务日；纯日期串（YYYY-MM-DD）原样视为业务日；无法解析 → null（不猜） */
export function shanghaiDay(v: DateLike): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    return shanghaiDayOf(new Date(t));
  }
  if (!(v instanceof Date) || !Number.isFinite(v.getTime())) return null;
  return shanghaiDayOf(v);
}

/**
 * 两个业务日（YYYY-MM-DD）之间的日历天差（to − from）。
 * 按 UTC 午夜直减：业务日已由上面的日界函数定锚，这里不得再引入本地时区。
 */
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
