/**
 * 运维手动触发已登记任务（2026-09-04 审计 #10）。
 *
 * 事故形态：33 个定时任务、5 条连接器同步与 2 个权限探测**在应用里一个都跑不了**，
 * 而 `/admin/health` 的空态还写着「可手动运行已登记任务」——页面在说一件做不到的事。
 * 恢复一次同步要 SSH 进机器跑 `jobs/cli.ts run-job`。
 *
 * 口径：
 *  - 只接受 `INTERVAL_JOBS` 里登记过的名字（白名单，未知名 404）；
 *  - 复用 `runNamedIntervalJobOnce`——它是手跑的唯一入口，会落 job_runs，
 *    否则失败看门狗仍把任务判作连续失败；
 *  - 同名任务的并发重复点击用进程内锁挡住：一次同步动辄十几分钟、
 *    并发跑两遍会把外部接口配额打光，也会让 checkpoint 互相覆盖；
 *  - 每次触发写审计（谁在什么时候手跑了哪个任务、结果如何）。
 */
import { getDbAsync } from "@/db";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { INTERVAL_JOBS, runNamedIntervalJobOnce } from "@/jobs/interval-runner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 可手动触发的任务名（页面据此渲染按钮；与调度目录同一份清单） */
export function manualRunnableJobNames(): string[] {
  return INTERVAL_JOBS.map((j) => j.name);
}

/**
 * 进程内并发锁。跨进程不保证互斥（生产是单进程 Next；pg-boss 模式下调度权威在 pg-boss），
 * 但足以挡住真实场景：管理员在页面上把「立即运行」连点三下。
 */
const running = new Set<string>();

export function isJobRunning(name: string): boolean {
  return running.has(name);
}

export interface ManualJobRunResult {
  job: string;
  ok: boolean;
  /** 任务自身返回的摘要（失败时为 null） */
  summary: unknown;
  message: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export async function runJobManually(
  user: SessionUser,
  name: string,
  dbArg?: AnyDb,
): Promise<ManualJobRunResult> {
  if (!user.roles.includes("admin")) throw new ApiError(403, "仅管理员可手动触发已登记任务");
  if (!INTERVAL_JOBS.some((j) => j.name === name)) {
    throw new ApiError(404, `未登记的任务：${name}`);
  }
  if (running.has(name)) {
    throw new ApiError(409, `任务 ${name} 正在运行中，请等待本轮结束再触发`);
  }
  running.add(name);
  const startedAt = new Date();
  let ok = true;
  let summary: unknown = null;
  let message = "";
  try {
    summary = await runNamedIntervalJobOnce(name, dbArg);
    try {
      message = JSON.stringify(summary) ?? "";
    } catch {
      message = String(summary);
    }
  } catch (e) {
    ok = false;
    message = e instanceof Error ? e.message : String(e);
  } finally {
    running.delete(name);
  }
  const finishedAt = new Date();

  /* 审计与 job_runs 是两件事：job_runs 记「任务跑了、结果如何」（看门狗读它），
     审计记「是谁按的按钮」。手动触发必须两边都有。 */
  const db: AnyDb = dbArg ?? (await getDbAsync());
  await writeAudit(db, {
    userId: user.id,
    entity: "job_run",
    action: "manual_run",
    after: { job: name, ok, message: message.slice(0, 500), durationMs: finishedAt.getTime() - startedAt.getTime() },
  });

  return {
    job: name,
    ok,
    summary: ok ? summary : null,
    message: message.slice(0, 500),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}
