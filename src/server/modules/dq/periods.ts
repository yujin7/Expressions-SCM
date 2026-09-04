import { shanghaiDayOf } from "@/server/core/business-day";
/**
 * D65 核对周期键（纯函数，Asia/Shanghai）：week = ISO 周 'YYYY-Www'，month = 'YYYY-MM'。
 * 与 data_quality_reviews 的 CHECK 约束同形（`ck_data_quality_reviews_key`）。
 */

export type ReviewPeriodKind = "week" | "month";

export const WEEK_KEY_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Asia/Shanghai 今日（YYYY-MM-DD），日界走 core/business-day 唯一权威 */
export function todayShanghai(now: Date = new Date()): string {
  return shanghaiDayOf(now);
}

function utcDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`日期格式须为 YYYY-MM-DD: ${iso}`);
  return new Date(`${iso}T00:00:00.000Z`);
}

/** ISO 8601 周键（周一为一周之始；跨年周归属含周四的那一年） */
export function isoWeekKey(iso: string): string {
  const d = utcDate(iso);
  const day = d.getUTCDay() || 7; // 1..7（周一=1）
  d.setUTCDate(d.getUTCDate() + 4 - day); // 移到本周周四
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function monthKey(iso: string): string {
  utcDate(iso);
  return iso.slice(0, 7);
}

/** 周键的起止日（周一 ~ 周日） */
export function isoWeekRange(weekKey: string): { from: string; through: string } {
  if (!WEEK_KEY_RE.test(weekKey)) throw new Error(`周键格式须为 YYYY-Www: ${weekKey}`);
  const year = Number(weekKey.slice(0, 4));
  const week = Number(weekKey.slice(6));
  // 第 1 周 = 含 1 月 4 日的那周
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: monday.toISOString().slice(0, 10), through: sunday.toISOString().slice(0, 10) };
}

export function monthRange(month: string): { from: string; through: string } {
  if (!MONTH_KEY_RE.test(month)) throw new Error(`月键格式须为 YYYY-MM: ${month}`);
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, through: `${month}-${String(last).padStart(2, "0")}` };
}

export function periodRange(kind: ReviewPeriodKind, key: string): { from: string; through: string } {
  return kind === "week" ? isoWeekRange(key) : monthRange(key);
}

/** 上一个周期键（周：减 7 天；月：减 1 月） */
export function previousPeriodKey(kind: ReviewPeriodKind, key: string): string {
  if (kind === "week") {
    const { from } = isoWeekRange(key);
    const d = utcDate(from);
    d.setUTCDate(d.getUTCDate() - 7);
    return isoWeekKey(d.toISOString().slice(0, 10));
  }
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 本周期键：周核对取「上一完整 ISO 周」（周一生成上周核对包），月核对取「上一完整月」 */
export function reviewPeriodKeyFor(kind: ReviewPeriodKind, today: string): string {
  return kind === "week" ? previousPeriodKey("week", isoWeekKey(today)) : previousPeriodKey("month", monthKey(today));
}

export interface CadenceHistoryRow {
  periodKey: string;
  /** 该周期是否「完成且达标」：全部来源类 completed 且准确率 ≥ 各自目标（waived 不算达标） */
  met: boolean;
}

/**
 * D65 节奏裁决：最近 requiredStreak（默认 4）个连续周核对全部完成且达标 → 切换为月核对；
 * 否则周核对。历史任意顺序传入（内部按 periodKey 降序）；不足 4 周恒为周核对。
 */
export function decideCadence(
  history: CadenceHistoryRow[],
  requiredStreak = 4,
): { cadence: ReviewPeriodKind; streak: number; reason: string } {
  const sorted = [...history].sort((a, b) => b.periodKey.localeCompare(a.periodKey));
  let streak = 0;
  for (const row of sorted) {
    if (!row.met) break;
    streak += 1;
    if (streak >= requiredStreak) break;
  }
  if (streak >= requiredStreak) {
    return { cadence: "month", streak, reason: `连续 ${streak} 周核对完成且达标，转为月核对` };
  }
  return { cadence: "week", streak, reason: streak === 0 ? "尚无连续达标的周核对，维持周核对" : `连续达标 ${streak}/${requiredStreak} 周，维持周核对` };
}
