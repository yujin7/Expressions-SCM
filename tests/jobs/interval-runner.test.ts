import { describe, it, expect, beforeAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { jobRuns } from "@/db/schema";
import {
  ensureIntervalJobsStarted,
  INTERVAL_JOBS,
  runIntervalJobOnce,
  runNamedIntervalJobOnce,
} from "@/jobs/interval-runner";

describe("interval-runner 进程内调度回退", () => {
  let db: TestDb;

  beforeAll(async () => {
    ({ db } = await createTestDb());
  });

  it("test 环境 ensureIntervalJobsStarted 为 no-op（不注册、不抛错）", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(() => ensureIntervalJobsStarted()).not.toThrow();
    const g = globalThis as unknown as Record<symbol, unknown>;
    expect(g[Symbol.for("supply-chain.interval-runner")]).toBeUndefined();
  });

  it("注册了 18 个任务（含 JST/简道云观察、rollup 与决策摘要）", () => {
    expect(INTERVAL_JOBS.map((j) => j.name).sort()).toEqual([
      "data-freshness",
      "decision-digest",
      "doc-aging",
      "exception-notify",
      "housekeeping",
      "job-failure-watchdog",
      "jst-token-watchdog",
      "license-alert",
      "notify-dispatch",
      "reconcile-jst",
      "rollup",
      "snapshot-age",
      "sync-jiandaoyun-catalog",
      "sync-jiandaoyun-forms",
      "sync-jst-inventory",
      "sync-jst-sales",
      "sync-yonyou",
      "system-alert-notify",
    ]);
  });

  it("runIntervalJobOnce 成功路径：job_runs 落 ok=true + summary 摘要", async () => {
    const r = await runIntervalJobOnce(
      { name: "noop-ok", everyMs: 1, run: async () => ({ hello: "world" }) },
      db,
    );
    expect(r.ok).toBe(true);
    const rows = await db.select().from(jobRuns);
    const row = rows.find((x) => x.job === "noop-ok");
    expect(row?.ok).toBe(true);
    expect(row?.message).toContain("hello");
    expect(row!.finishedAt.getTime()).toBeGreaterThanOrEqual(row!.startedAt.getTime());
  });

  it("runIntervalJobOnce 失败路径：job_runs 落 ok=false + 错误信息（截断 500）", async () => {
    const r = await runIntervalJobOnce(
      {
        name: "noop-fail",
        everyMs: 1,
        run: async () => {
          throw new Error("boom ".repeat(200));
        },
      },
      db,
    );
    expect(r.ok).toBe(false);
    const rows = await db.select().from(jobRuns);
    const row = rows.find((x) => x.job === "noop-fail");
    expect(row?.ok).toBe(false);
    expect(row?.message).toContain("boom");
    expect((row?.message ?? "").length).toBeLessThanOrEqual(500);
  });

  it("真实任务（snapshot-age）空库运行不抛错并留痕", async () => {
    const job = INTERVAL_JOBS.find((j) => j.name === "snapshot-age")!;
    const r = await runIntervalJobOnce(job, db);
    expect(r.ok).toBe(true);
    const rows = await db.select().from(jobRuns);
    expect(rows.some((x) => x.job === "snapshot-age" && x.ok)).toBe(true);
  });

  it("运维手跑只接受已登记任务，并与调度器共用 job_runs 留痕", async () => {
    await expect(runNamedIntervalJobOnce("snapshot-age", db)).resolves.toBeDefined();
    await expect(runNamedIntervalJobOnce("not-registered", db)).rejects.toThrow("未知已登记任务");
    const rows = await db.select().from(jobRuns);
    expect(rows.some((x) => x.job === "snapshot-age" && x.ok)).toBe(true);
    expect(rows.some((x) => x.job === "not-registered")).toBe(false);
  });

  it("运维恢复拒绝 skipped，并把它留成失败记录而非虚假恢复", async () => {
    const job = {
      name: "manual-skipped-test",
      everyMs: 1,
      run: async () => ({ status: "skipped", reason: "连接器未启用" }),
    };
    INTERVAL_JOBS.push(job);
    try {
      await expect(runNamedIntervalJobOnce(job.name, db)).rejects.toThrow("Skipped: 连接器未启用");
    } finally {
      INTERVAL_JOBS.splice(INTERVAL_JOBS.indexOf(job), 1);
    }
    const rows = await db.select().from(jobRuns);
    expect(rows.some((x) => x.job === job.name && !x.ok && x.message?.includes("Skipped"))).toBe(true);
  });

  it("运维恢复要求 job_runs 真正落库，不能在留痕失败时退出 0", async () => {
    const job = {
      name: "manual-ledger-failure-test",
      everyMs: 1,
      run: async () => ({ status: "succeeded" }),
    };
    const brokenLedgerDb = {
      insert: () => ({ values: async () => { throw new Error("ledger unavailable"); } }),
    };
    INTERVAL_JOBS.push(job);
    try {
      await expect(runNamedIntervalJobOnce(job.name, brokenLedgerDb)).rejects.toThrow("job_runs 留痕失败");
    } finally {
      INTERVAL_JOBS.splice(INTERVAL_JOBS.indexOf(job), 1);
    }
  });
});
