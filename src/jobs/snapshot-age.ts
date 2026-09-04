/**
 * snapshot-age（UAT 缺口 #3）：快照仓数据龄告警——快照仓（accountingMode='snapshot'）
 * 的最新 stock_snapshots.bizDate 距今超过阈值（默认 3 天）即告警；从未导入过快照的
 * 快照仓恒告警（latestBizDate=null）。
 *
 * 与 license-alert 同一形态：纯查询、无副作用、不写 audit_logs（系统无 id=0 伪用户，
 * 见 license-alert.ts 头注决策 W4）；结果由 API/工作台实时出数，pg_boss 每日跑一次仅留日志。
 */
import { and, eq, sql } from "drizzle-orm";
import { stockSnapshots, warehouses } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";
import { todayShanghai } from "@/server/core/business-day";

export const SNAPSHOT_AGE_THRESHOLD_DAYS = 3;

export interface SnapshotAgeAlertRow {
  warehouseId: number;
  code: string;
  name: string;
  /** 最新快照业务日期；null=该快照仓从未导入过快照 */
  latestBizDate: string | null;
  /** 数据龄（今日-最新快照，天）；null=从未导入 */
  ageDays: number | null;
}

export interface SnapshotAgeSummary {
  today: string;
  thresholdDays: number;
  alertCount: number;
  alerts: SnapshotAgeAlertRow[];
}

function diffDays(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);
}

/** 数据龄 > thresholdDays（或从未导入）的快照仓，按 ageDays 降序（never 置顶） */
export async function runSnapshotAgeAlert(
  db: AnyDb,
  opts?: { today?: string; thresholdDays?: number },
): Promise<SnapshotAgeSummary> {
  const t = opts?.today ?? todayShanghai();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`today 格式须为 YYYY-MM-DD: ${t}`);
  const threshold = opts?.thresholdDays ?? SNAPSHOT_AGE_THRESHOLD_DAYS;
  if (!Number.isInteger(threshold) || threshold < 0) throw new Error(`thresholdDays 须为非负整数: ${threshold}`);

  // 每仓最新快照日期（groupBy 子查询 + leftJoin——与 queries.ts listSnapshotBalances 同型）
  const latestSq = db
    .select({
      warehouseId: stockSnapshots.warehouseId,
      maxDate: sql<string>`max(${stockSnapshots.bizDate})`.as("max_date"),
    })
    .from(stockSnapshots)
    .groupBy(stockSnapshots.warehouseId)
    .as("latest");

  const rows: { id: number; code: string; name: string; latest: string | null }[] = await db
    .select({
      id: warehouses.id,
      code: warehouses.code,
      name: warehouses.name,
      latest: latestSq.maxDate,
    })
    .from(warehouses)
    .leftJoin(latestSq, eq(latestSq.warehouseId, warehouses.id))
    .where(and(eq(warehouses.accountingMode, "snapshot"), eq(warehouses.active, true)));

  const alerts: SnapshotAgeAlertRow[] = rows
    .map((r) => ({
      warehouseId: r.id,
      code: r.code,
      name: r.name,
      latestBizDate: r.latest,
      ageDays: r.latest ? diffDays(r.latest, t) : null,
    }))
    .filter((r) => r.ageDays === null || r.ageDays > threshold)
    .sort((a, b) => (b.ageDays ?? Number.MAX_SAFE_INTEGER) - (a.ageDays ?? Number.MAX_SAFE_INTEGER));

  return { today: t, thresholdDays: threshold, alertCount: alerts.length, alerts };
}
