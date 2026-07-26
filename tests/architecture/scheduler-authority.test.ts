import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { INTERVAL_JOBS } from "@/jobs/interval-runner";
import { SCHEDULES } from "@/jobs/scheduler";

const root = process.cwd();

describe("计划任务只有一个运行权威", () => {
  it("PostgreSQL 与 PGlite 在 instrumentation 中互斥接线", async () => {
    const source = await readFile(path.join(root, "src/instrumentation.ts"), "utf8");
    expect(source).toContain('process.env.NEXT_RUNTIME === "nodejs"');
    expect(source).not.toContain('process.env.NEXT_RUNTIME !== "nodejs"');
    expect(source).toContain('startsWith("postgres")');
    expect(source).toContain("ensureSchedulerStarted");
    expect(source).toContain("ensureIntervalJobsStarted");
  });

  it("pg-boss 为完整任务目录逐项登记 cron，不遗失 interval 回退任务", async () => {
    const source = await readFile(path.join(root, "src/jobs/scheduler.ts"), "utf8");
    expect(Object.keys(SCHEDULES).sort()).toEqual(INTERVAL_JOBS.map((job) => job.name).sort());
    expect(source).toContain("for (const job of INTERVAL_JOBS)");
    expect(source).toContain("runIntervalJobOnce(job)");
  });
});
