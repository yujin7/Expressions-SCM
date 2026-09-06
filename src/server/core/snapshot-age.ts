/**
 * 活跃快照仓的最新业务日健康：运维面板与 snapshot-age 任务共用的只读权威。
 * 仅衡量每仓 MAX(bizDate)，不证明整仓快照完整、SKU 覆盖或来源同步成功。
 */
import { and, eq, sql } from "drizzle-orm";
import { stockSnapshots, warehouses } from "@/db/schema";
import { dayDiff, shanghaiDay, todayShanghai } from "@/server/core/business-day";
import type { AnyDb } from "@/server/core/svc";

export const SNAPSHOT_AGE_THRESHOLD_DAYS = 3;

export interface SnapshotAgeRow {
  warehouseId: number;
  code: string;
  name: string;
  latestBizDate: string | null;
  ageDays: number | null;
  ageState: "fresh" | "stale" | "missing" | "future" | "invalid";
}

export interface SnapshotAgeOptions {
  today?: string;
  thresholdDays?: number;
}

function isBusinessDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && shanghaiDay(value) === value;
}

function isThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 无法解释的日期保留未知年龄，绝不转成 0 天或回退到更旧日期。 */
export function snapshotAgeEvidence(
  latest: unknown,
  today: string,
  thresholdDays = SNAPSHOT_AGE_THRESHOLD_DAYS,
): Pick<SnapshotAgeRow, "latestBizDate" | "ageDays" | "ageState"> {
  const latestBizDate = typeof latest === "string" ? latest : null;
  if (!isBusinessDay(today) || !isThreshold(thresholdDays)) {
    return { latestBizDate, ageDays: null, ageState: "invalid" };
  }
  if (latest === null) return { latestBizDate, ageDays: null, ageState: "missing" };
  if (!isBusinessDay(latest)) return { latestBizDate, ageDays: null, ageState: "invalid" };
  const ageDays = dayDiff(latest, today);
  if (!Number.isSafeInteger(ageDays)) return { latestBizDate, ageDays: null, ageState: "invalid" };
  return {
    latestBizDate,
    ageDays,
    ageState: ageDays < 0 ? "future" : ageDays > thresholdDays ? "stale" : "fresh",
  };
}

export async function readSnapshotAges(db: AnyDb, opts?: SnapshotAgeOptions): Promise<{
  today: string;
  thresholdDays: number;
  rows: SnapshotAgeRow[];
}> {
  // 只缺省/undefined 采用默认值；显式非法值（包括 null）必须在查询前拒绝。
  const today = opts?.today === undefined ? todayShanghai() : opts.today;
  const thresholdDays = opts?.thresholdDays === undefined ? SNAPSHOT_AGE_THRESHOLD_DAYS : opts.thresholdDays;
  if (!isBusinessDay(today)) throw new Error("today 须为有效业务日 YYYY-MM-DD");
  if (!isThreshold(thresholdDays)) throw new Error("thresholdDays 须为非负安全整数");

  const latestSq = db.select({
    warehouseId: stockSnapshots.warehouseId,
    maxDate: sql<unknown>`max(${stockSnapshots.bizDate})`.as("max_date"),
  }).from(stockSnapshots).groupBy(stockSnapshots.warehouseId).as("latest");
  const rows: { id: number; code: string; name: string; latest: unknown }[] = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, latest: latestSq.maxDate })
    .from(warehouses)
    .leftJoin(latestSq, eq(latestSq.warehouseId, warehouses.id))
    .where(and(eq(warehouses.accountingMode, "snapshot"), eq(warehouses.active, true)))
    .orderBy(warehouses.code, warehouses.id);

  return {
    today,
    thresholdDays,
    rows: rows.map((row) => ({
      warehouseId: row.id, code: row.code, name: row.name,
      ...snapshotAgeEvidence(row.latest, today, thresholdDays),
    })),
  };
}
