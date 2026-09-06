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
 *  - 并发互斥走 **`job_locks` 表**（见下）；
 *  - 每次触发写审计（谁在什么时候手跑了哪个任务、结果如何）。
 *
 * ── 并发互斥这件事，此前的注释说的不是实情（2026-09-04 安全审计 S4）──
 * 原来这里用一个模块级 `Set` 挡重复点击，并写着「并发跑两遍会把外部接口配额打光，
 * 也会让 checkpoint 互相覆盖」。但那个 Set 只挡得住**同一进程内、同样走这条路**的第二次触发：
 * PGlite 回退调度器有它自己闭包里的另一个 Set，生产环境根本不用这两者——
 * 是 pg-boss 的 `boss.work(...)` 在驱动，两个 Set 一个都不碰。
 * 也就是说，正被调度执行的 `sync-jiandaoyun-forms`（一轮约 12 分钟、约 850 次三方分页请求）
 * 遇上一次手动「立即运行」，会真的跑两遍——恰恰是注释声称已经防住的那件事。
 *
 * 现在的保证（也只保证这些）：
 *  · **同一个数据库上，同一个任务名同一时刻只有一个执行者**，无论触发者是 pg-boss、
 *    进程内回退定时器，还是这里的手动触发；胜者由 `job_locks` 上的一条原子语句裁决。
 *  · 手动触发另有**冷却期**（默认 60s，`MANUAL_JOB_COOLDOWN_MS` 可调）：
 *    没有冷却，这个端点可以被循环调用，锁只能保证「不并发」，保证不了「不刷」。
 *  · 持有者进程被 kill 时靠**租约到期**恢复，不靠释放动作——最坏情况是下一次触发要等租约走完。
 *  · **审计在释放锁之前写**：审计是「谁按了按钮」的唯一记录，不能落在互斥窗口之外
 *    （否则下一次触发可以在本次审计落库前就开始，两条记录的因果顺序就说不清了）。
 */
import { getDbAsync } from "@/db";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { INTERVAL_JOBS, runNamedIntervalJobOnce } from "@/jobs/interval-runner";
import { yonyouJobSummary, yonyouJobSummaryText, type YonyouJobSummary } from "@/lib/yonyou-job-summary";
import {
  acquireJobLock,
  DEFAULT_MANUAL_COOLDOWN_MS,
  isJobLocked,
  releaseJobLock,
} from "@/jobs/job-lock";

/** 可手动触发的任务名（页面据此渲染按钮；与调度目录同一份清单） */
export function manualRunnableJobNames(): string[] {
  return INTERVAL_JOBS.map((j) => j.name);
}

/** 手动触发的冷却期（毫秒）；测试与运维可用环境变量调整 */
export function manualJobCooldownMs(): number {
  const raw = Number(process.env.MANUAL_JOB_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MANUAL_COOLDOWN_MS;
}

/** 该任务此刻是否被任一调度器持有（跨进程可见——这是与旧的进程内 Set 的关键差别） */
export async function isJobRunning(name: string, dbArg?: AnyDb): Promise<boolean> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return isJobLocked(db, name);
}

export interface ManualJobRunResult {
  job: string;
  ok: boolean;
  /** 任务自身返回的摘要（失败时为 null） */
  summary: unknown;
  /** Bounded operational outcome; ok continues to mean execution health. */
  outcome?: YonyouJobSummary;
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
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const cooldownMs = manualJobCooldownMs();
  const lock = await acquireJobLock(db, name, { cooldownMs, holder: `manual:${user.id}` });
  if (!lock.acquired) {
    const seconds = Math.max(1, Math.ceil(lock.retryAfterMs / 1000));
    throw new ApiError(
      409,
      lock.reason === "running"
        ? `任务 ${name} 正在运行中（可能由计划调度触发），约 ${seconds} 秒后可再试。`
          + "并发跑两遍会打光外部接口配额，也会让两条 checkpoint 互相覆盖。"
        : `任务 ${name} 刚刚跑过，冷却中，请 ${seconds} 秒后再试。`,
    );
  }

  const startedAt = new Date();
  let ok = true;
  let summary: unknown = null;
  let message = "";
  try {
    /* 锁已在手上：让下游别再抢一次（同一把锁不可重入），也别再各写一套冷却。 */
    summary = await runNamedIntervalJobOnce(name, db, { lockHeld: true });
    try {
      message = JSON.stringify(summary) ?? "";
    } catch {
      message = String(summary);
    }
  } catch (e) {
    ok = false;
    message = e instanceof Error ? e.message : String(e);
  }
  const finishedAt = new Date();
  const outcome = name === "sync-yonyou" ? yonyouJobSummary(summary, ok) : undefined;
  const auditMessage = outcome ? JSON.stringify(outcome) : message.slice(0, 500);

  /* 审计与 job_runs 是两件事：job_runs 记「任务跑了、结果如何」（看门狗读它），
     审计记「是谁按的按钮」。手动触发必须两边都有，且审计要在**释放锁之前**落库。 */
  try {
    await writeAudit(db, {
      userId: user.id,
      entity: "job_run",
      action: "manual_run",
      after: { job: name, ok, message: auditMessage, durationMs: finishedAt.getTime() - startedAt.getTime() },
    });
  } finally {
    await releaseJobLock(db, lock);
  }

  return {
    job: name,
    ok,
    summary: ok ? outcome ?? summary : null,
    ...(outcome ? { outcome } : {}),
    message: outcome ? yonyouJobSummaryText(outcome) : message.slice(0, 500),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}
