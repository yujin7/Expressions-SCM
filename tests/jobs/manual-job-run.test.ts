/**
 * 手动触发已登记任务（2026-09-04 审计 #10）。
 *
 * 事故形态：33 个定时任务、5 条连接器同步与 2 个权限探测在应用里一个都跑不了，
 * 而 `/admin/health` 的空态还写着「可手动运行已登记任务」——页面在说一件做不到的事。
 * 恢复一次同步要 SSH 进机器跑 `jobs/cli.ts run-job`。
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { auditLogs, jobRuns, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

const mocks = vi.hoisted(() => ({ db: null as unknown, getFreshSessionUser: vi.fn() }));
vi.mock("@/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/db")>();
  return { ...original, getDbAsync: vi.fn(async () => mocks.db) };
});
vi.mock("@/server/core/dto", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/core/dto")>();
  return { ...original, getFreshSessionUser: mocks.getFreshSessionUser };
});

const { POST } = await import("@/app/api/admin/jobs/[name]/run/route");
const { manualRunnableJobNames, runJobManually } = await import("@/server/modules/admin/job-run");
const { INTERVAL_JOBS, runIntervalJobOnce } = await import("@/jobs/interval-runner");
const { acquireJobLock, releaseJobLock } = await import("@/jobs/job-lock");

/** 无外部依赖、在空库上必然成功的任务——手动触发的冒烟对象 */
const HARMLESS_JOB = "license-alert";

let db: TestDb;
let admin: SessionUser;
let pmc: SessionUser;

beforeEach(async () => {
  ({ db } = await createTestDb());
  mocks.db = db;
  const [a] = await db.insert(users).values({ name: "管理员", roles: ["admin"], isApprover: true }).returning();
  const [p] = await db.insert(users).values({ name: "计划", roles: ["pmc"], isApprover: false }).returning();
  admin = { id: a.id, name: a.name, roles: ["admin"], isApprover: true };
  pmc = { id: p.id, name: p.name, roles: ["pmc"], isApprover: false };
  mocks.getFreshSessionUser.mockResolvedValue(admin);
});

const call = (name: string) =>
  POST(new NextRequest(`http://localhost/api/admin/jobs/${name}/run`, { method: "POST" }), {
    params: Promise.resolve({ name }),
  });

describe("POST /api/admin/jobs/[name]/run", () => {
  it("任务名白名单来自 INTERVAL_JOBS（页面与 API 同一份清单）", () => {
    expect(manualRunnableJobNames()).toEqual(INTERVAL_JOBS.map((j) => j.name));
    expect(manualRunnableJobNames()).toContain(HARMLESS_JOB);
    expect(manualRunnableJobNames().length).toBeGreaterThan(30);
  });

  it("非管理员 403", async () => {
    mocks.getFreshSessionUser.mockResolvedValue(pmc);
    const res = await call(HARMLESS_JOB);
    expect(res.status).toBe(403);
    await expect(runJobManually(pmc, HARMLESS_JOB, db)).rejects.toMatchObject({ status: 403 });
  });

  it("未登记的任务名 404（先校验名字，不把任意字符串喂进调度）", async () => {
    const res = await call("no-such-job");
    expect(res.status).toBe(404);
    await expect(runJobManually(admin, "rm -rf", db)).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(jobRuns)).toHaveLength(0);
  });

  it("跑一个无害任务：落 job_runs（看门狗读它）+ 留审计（谁按的按钮）", async () => {
    const res = await call(HARMLESS_JOB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: string; ok: boolean; durationMs: number };
    expect(body.job).toBe(HARMLESS_JOB);
    expect(body.ok, "空库上营业执照提醒必然成功").toBe(true);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);

    const runs = await db.select().from(jobRuns).where(eq(jobRuns.job, HARMLESS_JOB));
    expect(runs, "必须复用 runNamedIntervalJobOnce 的留痕路径，否则失败看门狗仍判连续失败").toHaveLength(1);
    expect(runs[0].ok).toBe(true);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "job_run"));
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("manual_run");
    expect(audits[0].userId).toBe(admin.id);
    expect(audits[0].after).toMatchObject({ job: HARMLESS_JOB, ok: true });
  });

  it("同名任务并发重复点击被挡住（同步跑两遍会打光外部配额、覆盖 checkpoint）", async () => {
    const [first, second] = await Promise.allSettled([
      runJobManually(admin, HARMLESS_JOB, db),
      runJobManually(admin, HARMLESS_JOB, db),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    // 冷却期内不能连点（此前无冷却，端点可被循环调用）；冷却过后仍可触发
    await expect(runJobManually(admin, HARMLESS_JOB, db)).rejects.toThrow(/冷却中/);
    process.env.MANUAL_JOB_COOLDOWN_MS = "0";
    try {
      await expect(runJobManually(admin, HARMLESS_JOB, db)).resolves.toMatchObject({ ok: true });
    } finally {
      delete process.env.MANUAL_JOB_COOLDOWN_MS;
    }
  });

  it("任务失败/跳过不抛 500，而是返回 ok:false 并写明原因", async () => {
    // 缺配置的同步任务返回 skipped → runNamedIntervalJobOnce 判为未完成真实工作
    const res = await runJobManually(admin, "sync-yonyou", db);
    expect(res.ok).toBe(false);
    expect(res.message.length).toBeGreaterThan(0);
    expect(res.summary).toBeNull();
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "job_run"));
    expect(audits[0].after).toMatchObject({ ok: false });
  });

  it.each([
    { status: "awaiting_authorization", flags: [true, true], waiting: ["甲", "乙"], label: "等待授权" },
    { status: "partial", flags: [false, true], waiting: ["乙"], label: "部分完成" },
    { status: "succeeded", flags: [false, false], waiting: [], label: "已读取" },
  ])("用友 $status 的手动结果、job 留痕和审计保持同一安全口径", async ({ status, flags, waiting, label }) => {
    const job = INTERVAL_JOBS.find((entry) => entry.name === "sync-yonyou")!;
    const stub = vi.spyOn(job, "run").mockResolvedValue({
      status, results: flags.map((blockedByConsoleGrant, i) => ({
        runId: i + 1, importJobId: blockedByConsoleGrant ? null : i + 1,
        sourceRows: blockedByConsoleGrant ? 0 : 501, stagedRows: blockedByConsoleGrant ? 0 : 501,
        replayed: false, blockedByConsoleGrant, raw: "DO_NOT_EXPOSE".repeat(100),
      })),
      awaitingConsoleGrant: waiting, scopeKey: "DO_NOT_EXPOSE_SCOPE",
    });
    try {
      const response = await call(job.name);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ ok: true, outcome: { status, total: 2, waiting: waiting.length } });
      expect(result.message).toContain(label);
      expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPOSE");
      const [run] = await db.select().from(jobRuns).where(eq(jobRuns.job, job.name));
      expect(run.ok).toBe(true);
      expect(JSON.parse(run.message!)).toEqual(result.outcome);
      const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entity, "job_run"));
      expect(audit.after).toMatchObject({ job: job.name, ok: true, message: run.message });
    } finally { stub.mockRestore(); }
  });
});

/**
 * S4（2026-09-04 安全审计）：互斥必须**跨调度器**。
 *
 * 此前手动触发用 `admin/job-run.ts` 的一个模块级 Set，PGlite 回退调度器用它闭包里的另一个 Set，
 * 生产是 pg-boss 的 `boss.work(...)`——三者互不知道对方存在。于是计划中的
 * `sync-jiandaoyun-forms`（一轮约 12 分钟、约 850 次三方分页请求）跑到一半时点「立即运行」，
 * 同一个同步真的会跑两遍：外部配额被打光，两条 checkpoint 互相覆盖。
 * 唯一互斥点现在是 `job_locks` 表，胜者由数据库的一条原子语句裁决。
 */
describe("S4 任务互斥跨调度器（job_locks）", () => {
  const HARMLESS = INTERVAL_JOBS.find((j) => j.name === HARMLESS_JOB)!;

  it("调度器路径正在跑时，手动「立即运行」被 409 挡住（此前两个 Set 互不可见）", async () => {
    const lock = await acquireJobLock(db, HARMLESS_JOB, {});
    expect(lock.acquired, "先由「调度器」拿到锁").toBe(true);
    try {
      await expect(runJobManually(admin, HARMLESS_JOB, db)).rejects.toMatchObject({ status: 409 });
      await expect(runJobManually(admin, HARMLESS_JOB, db)).rejects.toThrow(/正在运行中/);
      expect(await db.select().from(jobRuns), "被互斥挡下的触发不是一次运行，不得写 job_runs").toHaveLength(0);
    } finally {
      if (lock.acquired) await releaseJobLock(db, lock);
    }
  });

  it("反向也成立：手动持锁时，调度器路径不执行任务且不记 job_runs", async () => {
    const lock = await acquireJobLock(db, HARMLESS_JOB, { holder: "manual:test" });
    expect(lock.acquired).toBe(true);
    try {
      const r = await runIntervalJobOnce(HARMLESS, db);
      expect(r.lock, "调度器得知道自己没抢到").toBe("running");
      expect(r.recorded).toBe(false);
      expect(await db.select().from(jobRuns)).toHaveLength(0);
    } finally {
      if (lock.acquired) await releaseJobLock(db, lock);
    }
    // 释放后调度器照常跑
    const after = await runIntervalJobOnce(HARMLESS, db);
    expect(after.lock).toBe("acquired");
    expect(after.recorded).toBe(true);
  });

  it("审计在释放锁之前写：拿到锁的人一定留下了「谁按的按钮」", async () => {
    await runJobManually(admin, HARMLESS_JOB, db);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "job_run"));
    expect(audits).toHaveLength(1);
    // 审计已落库，锁也已释放（下一次抢锁只可能被冷却期挡住，不会被「运行中」挡住）
    const retry = await acquireJobLock(db, HARMLESS_JOB, { cooldownMs: 0 });
    expect(retry.acquired).toBe(true);
    if (retry.acquired) await releaseJobLock(db, retry);
  });

  it("代码里不得再留下自称互斥的进程内 Set（注释说的必须是实情）", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    const src = readFileSync(path.join(root, "src/server/modules/admin/job-run.ts"), "utf8");
    expect(src, "手动触发不得再用模块级 Set 当锁").not.toMatch(/new Set<string>\(\)/);
    expect(src).toContain("acquireJobLock");
    expect(src, "冷却期是这次修复的一部分：没有它端点可以被循环调用").toContain("cooldownMs");
  });
});

describe("/admin/health 的任务表确实能触发（页面此前在说一件做不到的事）", () => {
  it("健康度载荷下发已登记任务名，页面据此列出全部任务而不只是跑过的", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    const health = readFileSync(path.join(root, "src/server/modules/admin/health.ts"), "utf8");
    const client = readFileSync(path.join(root, "src/app/(app)/admin/health/health-client.tsx"), "utf8");

    expect(health).toContain("registeredJobs");
    // 动态 import 断静态模块环：静态引用 interval-runner 会把整张任务图拉进页面数据收集
    expect(health).toMatch(/await import\("@\/jobs\/interval-runner"\)/);
    expect(client).toContain("立即运行");
    expect(client).toContain("/api/admin/jobs/");
    // 空态不得再声称一件页面做不到的事
    expect(client).not.toContain("尚无已留痕的权限探测；可手动运行已登记任务");
  });
});
