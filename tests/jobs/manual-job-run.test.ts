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
const { INTERVAL_JOBS } = await import("@/jobs/interval-runner");

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
    // 锁在结束后释放：下一次仍可触发
    await expect(runJobManually(admin, HARMLESS_JOB, db)).resolves.toMatchObject({ ok: true });
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
