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
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { jobRuns, systemAlerts } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";

const ALERT_CATEGORY = "job_failure";
/** 连续失败达到这个次数才告警——低于此值视为可自愈的抖动 */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;
/** 每个任务回看的运行条数 */
const LOOKBACK_RUNS = 10;

export interface JobFailureWatchdogSummary {
  opened: number;
  autoClosed: number;
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

  const jobNames: { job: string }[] = await db
    .selectDistinct({ job: jobRuns.job })
    .from(jobRuns);

  const failing = new Map<string, { count: number; message: string | null }>();
  for (const { job } of jobNames) {
    const runs: { ok: boolean; message: string | null }[] = await db
      .select({ ok: jobRuns.ok, message: jobRuns.message })
      .from(jobRuns)
      .where(eq(jobRuns.job, job))
      .orderBy(desc(jobRuns.finishedAt), desc(jobRuns.id))
      .limit(LOOKBACK_RUNS);
    const leading = countLeadingFailures(runs);
    if (leading >= threshold) {
      failing.set(job, { count: leading, message: runs[0]?.message ?? null });
    }
  }

  const openAlerts: { id: number; refKey: string | null }[] = await db
    .select({ id: systemAlerts.id, refKey: systemAlerts.refKey })
    .from(systemAlerts)
    .where(and(
      eq(systemAlerts.category, ALERT_CATEGORY),
      eq(systemAlerts.status, "open"),
    ));
  const openByJob = new Set(openAlerts.map((a) => a.refKey).filter((k): k is string => k !== null));

  let opened = 0;
  for (const [job, info] of failing) {
    if (openByJob.has(job)) continue;
    await db.insert(systemAlerts).values({
      category: ALERT_CATEGORY,
      refKey: job,
      title: `定时任务「${job}」已连续失败 ${info.count} 次`,
      detail: `最近一次错误：${info.message ?? "（无错误信息）"}。`
        + `连续失败说明不是偶发抖动。请查 /admin/health 的任务与错误面板；`
        + `若是三方同步，先确认凭据/授权是否失效。`,
      severity: "high",
    });
    opened++;
  }

  // 已恢复的任务自动关闭（系统自动，非人工裁决）
  const recovered = openAlerts.filter((a) => a.refKey !== null && !failing.has(a.refKey));
  let autoClosed = 0;
  if (recovered.length > 0) {
    await db.update(systemAlerts).set({
      status: "resolved",
      autoResolved: true,
      resolvedAt: now,
    }).where(inArray(systemAlerts.id, recovered.map((a) => a.id)));
    autoClosed = recovered.length;
  }

  return { opened, autoClosed, failingJobs: [...failing.keys()].sort() };
}
