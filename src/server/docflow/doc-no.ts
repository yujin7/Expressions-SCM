import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { docCounters } from "@/db/schema";

/** 任意 drizzle PG 连接（node-postgres / PGlite / 事务均兼容） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = PgDatabase<any, any, any>;

const SHANGHAI_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 业务日期 = Asia/Shanghai 的 YYYYMMDD */
export function bizDateShanghai(now: Date = new Date()): string {
  // en-CA locale 输出 YYYY-MM-DD
  return SHANGHAI_FMT.format(now).replaceAll("-", "");
}

/**
 * 取号器（R8/B5）：doc_counters 单语句原子 upsert（INSERT … ON CONFLICT DO UPDATE
 * … RETURNING），并发安全；doc_no UNIQUE 兜底。禁止 MAX+1。
 * 格式：`${prefix}-${YYYYMMDD}-${0001}`（同前缀同业务日内递增，超 9999 自然变宽）。
 */
export async function nextDocNo(db: AnyDb, prefix: string, now?: Date): Promise<string> {
  const bizDate = bizDateShanghai(now);
  const rows = await db
    .insert(docCounters)
    .values({ prefix, bizDate, lastNo: 1 })
    .onConflictDoUpdate({
      target: [docCounters.prefix, docCounters.bizDate],
      set: { lastNo: sql`${docCounters.lastNo} + 1` },
    })
    .returning({ lastNo: docCounters.lastNo });
  const n = rows[0].lastNo;
  return `${prefix}-${bizDate}-${String(n).padStart(4, "0")}`;
}
