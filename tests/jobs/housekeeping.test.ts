import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, type TestDb } from "../helpers/db";
import { errorLogs, exportJobs, importJobs, jobRuns, stagingRows } from "@/db/schema";
import { runHousekeeping } from "@/jobs/housekeeping";

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-07-24T04:00:00Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

describe("housekeeping 保洁任务", () => {
  let db: TestDb;
  let exportDir: string;
  let oldFilePath: string;
  let outsideFilePath: string;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    exportDir = mkdtempSync(path.join(tmpdir(), "hk-exp-"));

    // ── import_jobs + staging_rows ──
    const [oldSuperseded] = await db
      .insert(importJobs)
      .values({ template: "jst_daily", filename: "old.xlsx", status: "superseded", createdBy: 1, createdAt: daysAgo(100) })
      .returning();
    const [freshSuperseded] = await db
      .insert(importJobs)
      .values({ template: "jst_daily", filename: "fresh.xlsx", status: "superseded", createdBy: 1, createdAt: daysAgo(10) })
      .returning();
    const [oldDone] = await db
      .insert(importJobs)
      .values({ template: "jst_daily", filename: "done.xlsx", status: "done", createdBy: 1, createdAt: daysAgo(100) })
      .returning();
    await db.insert(stagingRows).values([
      { importJobId: oldSuperseded.id, rowNo: 1, payload: {}, status: "committed" },
      { importJobId: oldSuperseded.id, rowNo: 2, payload: {}, status: "error" },
      { importJobId: freshSuperseded.id, rowNo: 1, payload: {}, status: "committed" },
      { importJobId: oldDone.id, rowNo: 1, payload: {}, status: "committed" },
    ]);

    // ── export_jobs（老 done 带文件 / 老 done 文件越界 / 新 done / 老 pending） ──
    oldFilePath = path.join(exportDir, "1-balance.csv");
    writeFileSync(oldFilePath, "a,b\n");
    outsideFilePath = path.join(tmpdir(), `hk-outside-${Date.now()}.csv`);
    writeFileSync(outsideFilePath, "x\n");
    await db.insert(exportJobs).values([
      { kind: "balance", status: "done", filePath: oldFilePath, requestedBy: 1, createdAt: daysAgo(40) },
      { kind: "balance", status: "failed", filePath: outsideFilePath, requestedBy: 1, createdAt: daysAgo(40) }, // 越界路径：删行但不删文件
      { kind: "balance", status: "done", filePath: null, requestedBy: 1, createdAt: daysAgo(5) },
      { kind: "balance", status: "pending", filePath: null, requestedBy: 1, createdAt: daysAgo(40) }, // pending 永不清
    ]);

    // ── error_logs / job_runs ──
    await db.insert(errorLogs).values([
      { errorId: "old00001", message: "old", createdAt: daysAgo(100) },
      { errorId: "new00001", message: "new", createdAt: daysAgo(1) },
    ]);
    await db.insert(jobRuns).values([
      { job: "snapshot-age", ok: true, message: "old", startedAt: daysAgo(40), finishedAt: daysAgo(40) },
      { job: "snapshot-age", ok: true, message: "new", startedAt: daysAgo(1), finishedAt: daysAgo(1) },
    ]);
  });

  it("按保留期清理并返回计数；重复运行幂等", async () => {
    const summary = await runHousekeeping(db, { now: NOW, exportDir });
    expect(summary).toEqual({
      stagingRowsDeleted: 2, // 仅 old superseded 的 2 行
      exportJobsDeleted: 2, // 老 done + 老 failed
      exportFilesUnlinked: 1, // 仅目录内文件；越界路径不删
      errorLogsDeleted: 1,
      jobRunsDeleted: 1,
    });

    // 任务头行保留；fresh superseded / done 任务的 staging 行保留
    const jobsLeft = await db.select().from(importJobs);
    expect(jobsLeft.length).toBe(3);
    const stagingLeft = await db.select().from(stagingRows);
    expect(stagingLeft.length).toBe(2);

    // 文件：目录内的被删，越界的保留
    expect(existsSync(oldFilePath)).toBe(false);
    expect(existsSync(outsideFilePath)).toBe(true);

    // 导出任务：新 done + 老 pending 保留
    const exportsLeft = await db.select().from(exportJobs);
    expect(exportsLeft.map((j) => j.status).sort()).toEqual(["done", "pending"]);

    // error_logs / job_runs 各留 1 条新的
    expect((await db.select().from(errorLogs)).map((r) => r.errorId)).toEqual(["new00001"]);
    expect((await db.select().from(jobRuns)).map((r) => r.message)).toEqual(["new"]);

    // 幂等：再跑一遍全 0
    const again = await runHousekeeping(db, { now: NOW, exportDir });
    expect(again).toEqual({
      stagingRowsDeleted: 0,
      exportJobsDeleted: 0,
      exportFilesUnlinked: 0,
      errorLogsDeleted: 0,
      jobRunsDeleted: 0,
    });
  });
});
