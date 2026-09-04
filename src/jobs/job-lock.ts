/**
 * 任务互斥锁：**跨调度器**的唯一互斥点（2026-09-04 安全审计 S4）。
 *
 * 为什么必须落库：本仓有三个各自独立的「调度器」——
 *  1. 生产用 pg-boss（`jobs/scheduler.ts` 的 `boss.work(...)`，可能跑在多个 Web 副本上）；
 *  2. PGlite 开发模式用 `jobs/interval-runner.ts` 的进程内定时器（闭包里一个 `busy` Set）；
 *  3. 运维在 `/admin/health` 点「立即运行」，走 `server/modules/admin/job-run.ts`
 *     （此前是另一个模块级 `Set`）。
 * 三处此前各自用进程内集合做重入保护，互不知道对方的存在，于是「计划中的同步正在跑」
 * 和「有人手动又点了一次」可以同时成立：`sync-jiandaoyun-forms` 单轮约 12 分钟、
 * 约 850 次三方分页请求，跑两遍会打光配额，并让两条 checkpoint 互相覆盖。
 *
 * 现在唯一的互斥点是 `job_locks` 表里那一行，胜者由数据库的一条原子语句裁决。
 *
 * ── 这把锁保证什么、不保证什么 ──
 * 保证：**同一个任务名在同一个数据库上，同一时刻只有一个执行者**（含 pg-boss 多副本、
 * PGlite 回退定时器、手动触发三方）。
 * 不保证：跨数据库（两套环境各跑各的，本就该如此）；也不保证「一定跑」——
 * 持有者进程被 kill 时靠**租约到期**恢复，而不是靠释放动作，因此最坏情况下
 * 一个任务会在租约到期后才被下一个执行者接手（没有释放动作的锁会把任务永久锁死，
 * 那比没有锁更糟）。
 */
import { sql } from "drizzle-orm";
import type { AnyDb } from "@/server/core/svc";

/** 默认租约：比最长的一轮同步（简道云约 12 分钟）留足余量，又不至于把崩溃锁死太久 */
export const DEFAULT_JOB_LEASE_MS = 45 * 60 * 1000;

/** 手动触发的默认冷却期：没有冷却，`POST /api/admin/jobs/{name}/run` 可以被循环调用 */
export const DEFAULT_MANUAL_COOLDOWN_MS = 60 * 1000;

export type JobLockDenial = "running" | "cooldown";

export interface JobLockHandle {
  job: string;
  holder: string;
  acquired: true;
}

export interface JobLockDenied {
  job: string;
  acquired: false;
  reason: JobLockDenial;
  /** 还要等多久（毫秒，向上取整；未知时为 0） */
  retryAfterMs: number;
}

export type JobLockResult = JobLockHandle | JobLockDenied;

export interface AcquireJobLockOptions {
  /** 租约时长；持有者崩溃后到期自动可抢占 */
  leaseMs?: number;
  /** 距离上一轮结束不足此值即拒绝（默认 0＝不设冷却，调度器路径用这个默认值） */
  cooldownMs?: number;
  /** 持有者标识，便于排障；释放时用它校验 */
  holder?: string;
}

function newHolder(): string {
  return `${process.pid}:${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 抢锁：一条原子语句。`ON CONFLICT DO UPDATE … WHERE` 的 WHERE 不成立时**不更新也不返回行**，
 * 因此「没抢到」与「抢到了」由数据库单点裁决，不依赖任何读-改-写窗口。
 */
export async function acquireJobLock(
  db: AnyDb,
  job: string,
  options: AcquireJobLockOptions = {},
): Promise<JobLockResult> {
  const leaseMs = Math.max(1000, options.leaseMs ?? DEFAULT_JOB_LEASE_MS);
  const cooldownMs = Math.max(0, options.cooldownMs ?? 0);
  const holder = options.holder ?? newHolder();
  const rows = await db.execute(sql`
    INSERT INTO job_locks (job, holder, locked_at, lease_until, last_finished_at)
    VALUES (${job}, ${holder}, now(), now() + make_interval(secs => ${leaseMs / 1000}), NULL)
    ON CONFLICT (job) DO UPDATE
      SET holder = excluded.holder,
          locked_at = now(),
          lease_until = excluded.lease_until
      WHERE job_locks.lease_until <= now()
        AND (
          job_locks.last_finished_at IS NULL
          OR job_locks.last_finished_at <= now() - make_interval(secs => ${cooldownMs / 1000})
        )
    RETURNING job
  `);
  if (resultRowCount(rows) > 0) return { job, holder, acquired: true };

  /* 没抢到：再读一次只为把「为什么」和「还要等多久」讲清楚（尽力而为，判定权仍在上面那条语句）。 */
  const state = await db.execute(sql`
    SELECT
      GREATEST(0, EXTRACT(EPOCH FROM (lease_until - now())))::float8 AS lease_left,
      GREATEST(0, EXTRACT(EPOCH FROM (last_finished_at + make_interval(secs => ${cooldownMs / 1000}) - now())))::float8 AS cooldown_left
    FROM job_locks WHERE job = ${job}
  `);
  const row = resultRows(state)[0] as { lease_left?: number; cooldown_left?: number } | undefined;
  const leaseLeft = Number(row?.lease_left ?? 0);
  const cooldownLeft = Number(row?.cooldown_left ?? 0);
  return leaseLeft > 0
    ? { job, acquired: false, reason: "running", retryAfterMs: Math.ceil(leaseLeft * 1000) }
    : { job, acquired: false, reason: "cooldown", retryAfterMs: Math.ceil(cooldownLeft * 1000) };
}

/**
 * 释放：只释放**自己**持有的那把（holder 校验）。
 * 租约已过期后被别人抢走时，这里什么都不做——否则会把后来者的锁释放掉。
 */
export async function releaseJobLock(db: AnyDb, handle: JobLockHandle): Promise<void> {
  await db.execute(sql`
    UPDATE job_locks
       SET lease_until = now(), last_finished_at = now()
     WHERE job = ${handle.job} AND holder = ${handle.holder}
  `);
}

/** 只读：某任务此刻是否被持有（页面提示用；判定权永远在 acquireJobLock） */
export async function isJobLocked(db: AnyDb, job: string): Promise<boolean> {
  const rows = await db.execute(sql`SELECT 1 FROM job_locks WHERE job = ${job} AND lease_until > now()`);
  return resultRowCount(rows) > 0;
}

/* ── drizzle 的 execute() 在 pg 与 PGlite 两个驱动下返回形状不同，统一在这里读 ── */

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function resultRowCount(result: unknown): number {
  return resultRows(result).length;
}
