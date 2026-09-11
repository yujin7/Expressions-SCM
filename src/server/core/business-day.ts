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

/** T+1 observation recency: historical/future windows remain readable, not current evidence. */
export function isCurrentObservationDay(anchor: string | null, now = new Date()): boolean {
  if (!anchor || shanghaiDay(anchor) !== anchor) return false;
  const age = dayDiff(anchor, shanghaiDayOf(now));
  return age >= 0 && age <= 1;
}

/** 最近 N 个已结束的上海业务日：[start, end)，不混入今天的部分日或未来记录。 */
export function completedShanghaiDays(days: number, today = todayShanghai()): {
  start: Date; end: Date; startDay: string; endDayExclusive: string; days: number;
} {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3660 || shanghaiDay(today) !== today) {
    throw new Error("完整业务日窗口须为有效日期及 1–3660 个整天");
  }
  const end = new Date(`${today}T00:00:00+08:00`);
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start, end, startDay: shanghaiDayOf(start), endDayExclusive: today, days };
}

/**
 * 任意时间 → Asia/Shanghai 业务日；纯日期串（YYYY-MM-DD）原样视为业务日；无法解析 → null（不猜）。
 *
 * 形状对≠日子存在：`"2026-13-45"` 能通过正则，此前就被原样放行，一路当成合法业务日
 * 传进 SQL，`('2026-13-45')::date` 在 Postgres 里炸成 500——「用户把日期填错了」
 * 于是变成一条服务端错误。这里必须真的验一次日历。
 */
export function shanghaiDay(v: DateLike): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      /* 回程比对挡住「月/日越界」与「2 月 30 日」这类形状合法但不存在的日期 */
      const t = Date.parse(`${s}T00:00:00Z`);
      return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : null;
    }
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

/** 业务月（Asia/Shanghai，YYYY-MM）——月度口径也只有这一处日界 */
export function shanghaiMonthOf(d: Date): string {
  return shanghaiDayOf(d).slice(0, 7);
}

/**
 * 业务日 + 上海小时（调度用）。
 *
 * 只有进程内调度器需要「小时」这一档：它要判断到点没有、以及同一小时内不重跑。
 * 放在本模块是因为它和业务日共用同一个时区锚点——分开写就又是一份会各自漂移的实现。
 * key 形如 `2026-09-05T14`（业务日 + 两位时），可直接当去重键。
 */
export function shanghaiHourKeyOf(d: Date): { hour: number; key: string } {
  const day = shanghaiDayOf(d);
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .find((p) => p.type === "hour")?.value,
  );
  return { hour, key: `${day}T${String(hour).padStart(2, "0")}` };
}

const SHANGHAI_TS_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  /* 必须是 hourCycle:"h23" 而不是 hour12:false：V8 对后者在午夜输出 "24:00:00"
     （Chromium 长期已知行为），导出的 CSV 里会出现 "2026-09-06 24:00:00" 这种不存在的时刻。 */
  hourCycle: "h23",
});

/**
 * 展示用业务时刻（Asia/Shanghai，`YYYY-MM-DD HH:mm:ss`；sv-SE locale 恰为该格式）。
 *
 * 审计台、导出中心和 CSV 导出各写过一份一模一样的 formatter。它虽然只用于显示，
 * 但「上海」这件事必须只有一个定义——否则改时区锚点时会漏掉其中两份，
 * 屏幕上的时间和导出文件里的时间就会各说各话。
 */
export function shanghaiTimestampOf(d: Date): string {
  return SHANGHAI_TS_FMT.format(d);
}
