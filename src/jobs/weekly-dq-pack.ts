/**
 * weekly-dq-pack（D65）：每周一生成本周核对包 + 飞书摘要（未注册到 interval-runner / scheduler——
 * 由编排方登记：建议 cron `0 9 * * 1`，Asia/Shanghai，排在 reconcile-jst 之后）。
 *
 * - 节奏由 dq/reviews.resolveCadence 裁决：本次即将生成的周期不计入，其前连续 4 周完成且达标 → 月核对包；
 *   切到月核对后粘滞（最近月核对待完成或完成且达标都维持月包），月核对被豁免/未达标才退回周包（规则见 resolveCadence 注释）；
 * - 外部平台准确率来自 sales-consistency：只比两侧都有数据的完整月，内部缺月（sales_monthly 晚于外部观察）跳过、
 *   不记为不一致，摘要里写明比较月/内部缺月（仅覆盖天猫）；
 * - 生成 data_quality_reviews pending 行（幂等：同周期已存在不重复）；
 * - 飞书单向通知走 notifications 队列（enqueueNotification，dedupeKey=dq-pack:<kind>:<key>），由 notify-dispatch 投递；
 * - 准确率低于目标的来源类开 system_alerts(category=data_quality, ref_key=<class>:<periodKey>)，已开则不重复；
 * - 纯查询 + 队列写，不写 audit_logs（系统无伪用户，与 snapshot-age / license-alert 同型）。
 */
import { and, eq } from "drizzle-orm";

import { systemAlerts } from "@/db/schema";
import { SOURCE_CLASS_DEFS } from "@/server/core/data-source-class";
import type { AnyDb } from "@/server/core/svc";
import { periodRange, todayShanghai } from "@/server/modules/dq/periods";
import { generateReviewPack, resolveCadence } from "@/server/modules/dq/reviews";
import { computeDataQuality, type DataQualityReport } from "@/server/modules/report/data-quality";
import { enqueueNotification } from "./notify";

export const DQ_ALERT_CATEGORY = "data_quality";

export interface WeeklyDqPackSummary {
  today: string;
  periodKind: "week" | "month";
  periodKey: string;
  cadenceReason: string;
  created: number;
  existing: number;
  belowTarget: { sourceClass: string; rate: number | null; targetPct: number | null }[];
  alertsOpened: number;
  notified: boolean;
  summaryText: string;
}

function fmtPct(v: number | null): string {
  return v == null ? "—" : `${v}%`;
}

export function buildDqSummaryText(report: DataQualityReport, periodKind: "week" | "month", periodKey: string): string {
  const range = periodRange(periodKind, periodKey);
  const lines = [
    `数据质量${periodKind === "week" ? "周" : "月"}核对包 ${periodKey}（${range.from} ~ ${range.through}）`,
    ...report.sources
      .filter((s) => SOURCE_CLASS_DEFS[s.sourceClass].targetAccuracyPct != null)
      .map((s) => `· ${s.label}：准确率 ${fmtPct(s.accuracy.rate)}（目标 ${fmtPct(s.accuracy.targetPct)}，n=${s.accuracy.n}）`
        + `｜及时 ${s.timeliness.latestAsOf ?? "未知"}${s.timeliness.status === "stale" ? "（过期）" : ""}`
        + `｜放行率 ${fmtPct(s.completeness.rate)}`),
    `· 快照跳变告警 ${report.snapshotQuality.alerts} 仓；本期手工改写指标 ${report.manualOverrides.count} 项；待核对 ${report.reviews.pending} 项`,
    `· 销量一致性（仅天猫）比较月 ${report.salesConsistency.comparedMonths.length > 0 ? report.salesConsistency.comparedMonths.join("、") : "无"}`
      + `；内部缺月 ${report.salesConsistency.skippedMonths.length > 0 ? report.salesConsistency.skippedMonths.join("、") : "无"}（跳过，不记为不一致）`,
  ];
  return lines.join("\n");
}

export async function runWeeklyDqPack(
  db: AnyDb,
  opts: { today?: string; notify?: boolean } = {},
): Promise<WeeklyDqPackSummary> {
  const today = opts.today ?? todayShanghai();
  const cadence = await resolveCadence(db, today);
  const report = await computeDataQuality(db, { today });
  const pack = await generateReviewPack(db, {
    periodKind: cadence.cadence,
    periodKey: cadence.periodKey,
    actorId: null,
    today,
    report,
  });

  const belowTarget = report.sources
    .filter((s) => s.accuracy.status === "below_target")
    .map((s) => ({ sourceClass: s.sourceClass, rate: s.accuracy.rate, targetPct: s.accuracy.targetPct }));
  let alertsOpened = 0;
  for (const b of belowTarget) {
    const refKey = `${b.sourceClass}:${cadence.periodKey}`;
    const open: { id: number }[] = await db
      .select({ id: systemAlerts.id })
      .from(systemAlerts)
      .where(and(eq(systemAlerts.category, DQ_ALERT_CATEGORY), eq(systemAlerts.refKey, refKey), eq(systemAlerts.status, "open")));
    if (open.length > 0) continue;
    await db.insert(systemAlerts).values({
      category: DQ_ALERT_CATEGORY,
      refKey,
      title: `${SOURCE_CLASS_DEFS[b.sourceClass].label} 准确率 ${fmtPct(b.rate)} 低于目标 ${fmtPct(b.targetPct)}`,
      detail: `核对周期 ${cadence.periodKey}；口径：${SOURCE_CLASS_DEFS[b.sourceClass].accuracyBasis}`,
      severity: "medium",
    });
    alertsOpened += 1;
  }

  const summaryText = buildDqSummaryText(report, cadence.cadence, cadence.periodKey);
  let notified = false;
  if (opts.notify !== false) {
    notified = await enqueueNotification(db, {
      channel: "feishu",
      title: `【数据质量】${cadence.cadence === "week" ? "周" : "月"}核对包 ${cadence.periodKey}`,
      body: summaryText,
      href: "/import/data-quality",
      severity: belowTarget.length > 0 ? "high" : "info",
      dedupeKey: `dq-pack:${cadence.cadence}:${cadence.periodKey}`,
      targetRole: "pmc",
    });
  }

  return {
    today,
    periodKind: cadence.cadence,
    periodKey: cadence.periodKey,
    cadenceReason: cadence.reason,
    created: pack.created,
    existing: pack.existing,
    belowTarget,
    alertsOpened,
    notified,
    summaryText,
  };
}
