/**
 * 定时任务连续失败看门狗。
 *
 * 事故预防（2026-08-04）：`job_runs` 忠实记录了每次任务的成败，`/admin/health` 也能看，
 * 但**没有任何东西在任务失败时告警**——要有人主动去开那个页面才会发现。
 * 对 6 小时一跑的三方同步来说，这正是"同步三周前就挂了，没人知道"的标准剧本。
 *
 * 本看门狗只做一件事：某个任务**最近 N 次全失败**就开告警，恢复成功后自动关闭。
 *
 * 为什么看"连续失败"而不是"失败过一次"：三方接口偶发超时是常态，
 * 单次失败就开单会让告警很快变成噪音，然后所有人开始无视它——
 * 那比没有告警更糟。连续失败才说明是持续故障而非抖动。
 *
 * W1（路线图）：告警写入统一走 alerts/engine.upsertAlerts——去重键幂等
 * （dedupeKey = job_failure:<job>）、责任角色取 rules/task-triggers.ALERT_OWNER_ROLE（唯一权威）、
 * 动作链接直达 /admin/health、sourceRule/paramsSnapshot/why 同行落库、事件进 alert_events 台账。
 * autoCloseAfterDays=0：任务跑成功一次即关（硬事实，不是数据缺口）——与迁移前一致。
 */
import { desc, eq } from "drizzle-orm";
import { jobRuns } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";
import { backfillAlertDedupeKeys, upsertAlerts, type AlertCandidate } from "@/server/modules/alerts/engine";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";

export const ALERT_CATEGORY = "job_failure";
export const JOB_FAILURE_SOURCE_RULE = "jobs/job-failure-watchdog（连续失败阈值）";
export const JOB_FAILURE_ACTION_HREF = "/admin/health";
/** 连续失败达到这个次数才告警——低于此值视为可自愈的抖动 */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;
/** 每个任务回看的运行条数 */
const LOOKBACK_RUNS = 10;

export interface JobFailureWatchdogSummary {
  opened: number;
  autoClosed: number;
  /** 已开告警本轮再次命中（失败次数刷新） */
  refreshed: number;
  /** 本轮回填 dedupe_key 的历史行数 */
  backfilled: number;
  failingJobs: string[];
}

/** 取最近若干次运行，判断开头连续失败了几次（按时间倒序，最新在前） */
export function countLeadingFailures(runs: readonly { ok: boolean }[]): number {
  let count = 0;
  for (const run of runs) {
    if (run.ok) break;
    count++;
  }
  return count;
}

export async function runJobFailureWatchdog(
  db: AnyDb,
  opts?: { now?: Date; threshold?: number },
): Promise<JobFailureWatchdogSummary> {
  const now = opts?.now ?? new Date();
  const threshold = opts?.threshold ?? CONSECUTIVE_FAILURE_THRESHOLD;
  const backfilled = await backfillAlertDedupeKeys(db, ALERT_CATEGORY);

  const jobNames: { job: string }[] = await db
    .selectDistinct({ job: jobRuns.job })
    .from(jobRuns);

  const failing = new Map<string, { count: number; message: string | null; lastAt: Date | null }>();
  for (const { job } of jobNames) {
    const runs: { ok: boolean; message: string | null; finishedAt: Date | null }[] = await db
      .select({ ok: jobRuns.ok, message: jobRuns.message, finishedAt: jobRuns.finishedAt })
      .from(jobRuns)
      .where(eq(jobRuns.job, job))
      .orderBy(desc(jobRuns.finishedAt), desc(jobRuns.id))
      .limit(LOOKBACK_RUNS);
    const leading = countLeadingFailures(runs);
    if (leading >= threshold) {
      failing.set(job, { count: leading, message: runs[0]?.message ?? null, lastAt: runs[0]?.finishedAt ?? null });
    }
  }

  const candidates: AlertCandidate[] = [...failing.entries()].map(([job, info]) => ({
    refKey: job,
    dedupeKey: `${ALERT_CATEGORY}:${job}`,
    title: `定时任务「${job}」已连续失败 ${info.count} 次`,
    detail: `最近一次错误：${info.message ?? "（无错误信息）"}。`
      + `连续失败说明不是偶发抖动。请查 /admin/health 的任务与错误面板；`
      + `若是三方同步，先确认凭据/授权是否失效。`,
    severity: "high",
    ownerRole: ALERT_OWNER_ROLE[ALERT_CATEGORY],
    actionHref: JOB_FAILURE_ACTION_HREF,
    sourceRule: JOB_FAILURE_SOURCE_RULE,
    paramsSnapshot: {
      job,
      consecutiveFailures: info.count,
      threshold,
      lookbackRuns: LOOKBACK_RUNS,
      lastFailedAt: info.lastAt ? new Date(info.lastAt).toISOString() : null,
    },
    why: [
      { label: "连续失败", value: `${info.count} 次（回看最近 ${LOOKBACK_RUNS} 次运行）`, source: "job_runs" },
      { label: "告警阈值", value: `${threshold} 次连续失败`, source: JOB_FAILURE_SOURCE_RULE },
      { label: "最近错误", value: info.message ?? "（无错误信息）", source: "job_runs.message" },
    ],
  }));

  const res = await upsertAlerts(db, {
    category: ALERT_CATEGORY,
    candidates,
    now,
    autoCloseAfterDays: 0, // 跑成功一次即关：恢复是硬事实，不需要数据缺口迟滞
  });
  return {
    opened: res.opened,
    autoClosed: res.autoClosed,
    refreshed: res.refreshed,
    backfilled,
    failingJobs: [...failing.keys()].sort(),
  };
}
