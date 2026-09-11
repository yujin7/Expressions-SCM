/**
 * snapshot-age：活跃快照仓最新日期健康，复用运维面板同一底层读服务。
 * 超过阈值（默认严格 >3 天）、缺失、未来日期及日期异常都保留明确原因。
 *
 * 与 license-alert 同一形态：纯查询、无副作用、不写 audit_logs（系统无 id=0 伪用户，
 * 见 license-alert.ts 头注决策 W4）；CLI 返回完整结果，已登记调度/手动运行由
 * interval-runner 留运行日志（通用日志摘要有长度上限，不等于完整仓清单）。
 */
import { readSnapshotAges, type SnapshotAgeOptions, type SnapshotAgeRow } from "@/server/core/snapshot-age";
import type { AnyDb } from "@/server/core/svc";

export { SNAPSHOT_AGE_THRESHOLD_DAYS } from "@/server/core/snapshot-age";

export type SnapshotAgeAlertRow = SnapshotAgeRow;

export interface SnapshotAgeSummary {
  today: string;
  thresholdDays: number;
  alertCount: number;
  alerts: SnapshotAgeAlertRow[];
}

/** 缺失/异常/未来置前；陈旧按龄降序，同类同龄按仓编码、ID 稳定排序。 */
export async function runSnapshotAgeAlert(
  db: AnyDb,
  opts?: SnapshotAgeOptions,
): Promise<SnapshotAgeSummary> {
  const { today, thresholdDays, rows } = await readSnapshotAges(db, opts);
  const rank = { missing: 0, invalid: 1, future: 2, stale: 3, fresh: 4 };
  const alerts = rows.filter((row) => row.ageState !== "fresh").sort((a, b) =>
    rank[a.ageState] - rank[b.ageState]
    || (b.ageDays ?? 0) - (a.ageDays ?? 0)
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
    || a.warehouseId - b.warehouseId,
  );
  return { today, thresholdDays, alertCount: alerts.length, alerts };
}
