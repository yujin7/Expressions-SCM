/** Bounded operational evidence, not business data or proof of downstream readiness. Zero imports. */
export const YONYOU_JOB_SUMMARY_VERSION = "yonyou-sync-job/v1";
export type YonyouJobState = "succeeded" | "partial" | "awaiting_authorization" | "skipped" | "failed" | "unknown";
export interface YonyouJobSummary {
  version: typeof YONYOU_JOB_SUMMARY_VERSION;
  status: YonyouJobState;
  total: number | null;
  readable: number | null;
  waiting: number | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100;
// Run/job IDs and source row counts are PostgreSQL int columns, not contract counts.
const rowCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const positiveId = (value: unknown): value is number => rowCount(value) && value > 0;
function observedResult(value: unknown): boolean {
  if (!object(value) || !positiveId(value.runId) || !rowCount(value.sourceRows) || !rowCount(value.stagedRows)
    || value.stagedRows > value.sourceRows || typeof value.replayed !== "boolean") return false;
  if (value.blockedByConsoleGrant === true) {
    return value.importJobId === null && value.sourceRows === 0 && value.stagedRows === 0;
  }
  // Old false replays had blocked=false but no import job. They are not evidence
  // of a completed read, even when their top-level status said succeeded.
  return value.blockedByConsoleGrant === false && positiveId(value.importJobId);
}
const uncertain = (status: "failed" | "unknown" | "skipped"): YonyouJobSummary =>
  ({ version: YONYOU_JOB_SUMMARY_VERSION, status, total: null, readable: null, waiting: null });

function counted(total: number, waiting: number): YonyouJobSummary {
  return {
    version: YONYOU_JOB_SUMMARY_VERSION,
    status: waiting === 0 ? "succeeded" : waiting === total ? "awaiting_authorization" : "partial",
    total, readable: total - waiting, waiting,
  };
}

/** Rebuild an allowlisted object; never spread raw summaries, scope, errors or contract names. */
export function yonyouJobSummary(value: unknown, ok = true): YonyouJobSummary {
  if (!ok) return uncertain("failed");
  if (!object(value)) return uncertain("unknown");
  if (value.version === YONYOU_JOB_SUMMARY_VERSION) {
    if (["failed", "unknown", "skipped"].includes(String(value.status))
      && value.total === null && value.readable === null && value.waiting === null) {
      return uncertain(value.status as "failed" | "unknown" | "skipped");
    }
    if (count(value.total) && value.total > 0 && count(value.readable) && count(value.waiting)
      && value.readable + value.waiting === value.total) {
      const summary = counted(value.total, value.waiting);
      if (value.status === summary.status) return summary;
    }
    return uncertain("unknown");
  }
  if (value.status === "skipped") return uncertain("skipped");
  // Also read intact legacy job JSON. Its top-level succeeded flag was incorrect
  // for blocked contracts; derive from checked result flags and the waiting list.
  if (!["succeeded", "partial", "awaiting_authorization"].includes(String(value.status))
    || !Array.isArray(value.results) || value.results.length < 1 || value.results.length > 100
    || !Array.isArray(value.awaitingConsoleGrant) || value.awaitingConsoleGrant.length > 100
    || !value.awaitingConsoleGrant.every((name) => typeof name === "string" && name.length > 0 && name.length <= 200)
    || !value.results.every(observedResult)) return uncertain("unknown");
  const waiting = value.results.filter((row) => row.blockedByConsoleGrant).length;
  if (waiting !== value.awaitingConsoleGrant.length) return uncertain("unknown");
  return counted(value.results.length, waiting);
}

/** job_runs.message is 500 characters: accept only a complete JSON document. */
export function parseYonyouJobSummary(message: string | null, ok: boolean): YonyouJobSummary {
  if (!ok) return uncertain("failed");
  if (!message || message.length > 500) return uncertain("unknown");
  try { return yonyouJobSummary(JSON.parse(message)); }
  catch { return uncertain("unknown"); }
}

export function yonyouJobSummaryText(summary: YonyouJobSummary): string {
  switch (summary.status) {
    case "succeeded": return `已读取 ${summary.readable}/${summary.total} 条契约；下游核对与 UAT 另行验收`;
    case "partial": return `部分完成：已读取 ${summary.readable}/${summary.total} 条契约，${summary.waiting} 条等待授权`;
    case "awaiting_authorization": return `等待授权：${summary.waiting}/${summary.total} 条契约尚未读取`;
    case "skipped": return "未执行：请核对同步配置、开关与执行人";
    case "failed": return "用友同步执行失败（详情仅限受控日志）";
    default: return "执行已结束，取数结果未确认（历史摘要不完整或无法识别）";
  }
}

/** Shared with the service: only this precise legacy shape is a retryable authorization wait. */
export type YonyouAuthorizationEvidence = {
  status: string; importJobId: number | null; error: string | null;
  sourceRows: number; stagedRows: number; rejectedRows: number;
  evidenceHash: string | null; evidencePath: string | null;
};
export function isYonyouAuthorizationWait(run: YonyouAuthorizationEvidence): boolean {
  return run.status === "succeeded" && /^待控制台授权：(310037|310005)$/.test(run.error ?? "")
    && run.importJobId === null && run.sourceRows === 0 && run.stagedRows === 0 && run.rejectedRows === 0
    && !run.evidenceHash && !run.evidencePath;
}

type YonyouRunEvidence = YonyouAuthorizationEvidence & { connector: string };

export function yonyouRunAwaitsAuthorization(run: YonyouRunEvidence): boolean {
  return (run.connector === "yy" || run.connector === "yonyou") && isYonyouAuthorizationWait(run);
}

/** The service refuses these contradictory legacy successes; the UI must not turn them green. */
export function yonyouRunResultInconsistent(run: YonyouRunEvidence): boolean {
  return (run.connector === "yy" || run.connector === "yonyou") && run.status === "succeeded"
    && !yonyouRunAwaitsAuthorization(run) && (!positiveId(run.importJobId) || run.error !== null);
}
