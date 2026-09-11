import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, type TestDb } from "../helpers/db";
import { errorLogs, exportJobs, importJobs, jobRuns, reportReadModelCache, stagingRows, notifications } from "@/db/schema";
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
      notificationsDeleted: 0, // 本用例未造已读通知；保留期逻辑另见下一用例
      readModelCacheDeleted: 0, // 本用例未造缓存行；保留期逻辑另见下一用例
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
      notificationsDeleted: 0,
      readModelCacheDeleted: 0,
    });
  });
});

/**
 * 通知保留期（2026-07-25 新增）。此前 notifications 无任何保留期，
 * 而列表硬截断 100 条且无分页——日推摘要按 3 条/天累积，约 33 天占满唯一视图。
 * 纪律：已读的按期清理；**未读永不自动删**（不替用户决定什么该被忽略）。
 */
describe("housekeeping 通知保留期", () => {
  it("只清理「唯一收件人且已读超期」；角色定向的不因他人已读被删", async () => {
    const { db } = await createTestDb();
    const old = new Date(Date.now() - 60 * 864e5);
    const recent = new Date(Date.now() - 3 * 864e5);

    await db.insert(notifications).values([
      // 定向个人（userId 非空）＝唯一收件人，readAt 语义准确
      { channel: "in_app", title: "定向-老的已读", body: "x", status: "sent", userId: 1, readAt: old },
      { channel: "in_app", title: "定向-近期已读", body: "x", status: "sent", userId: 1, readAt: recent },
      { channel: "in_app", title: "定向-老的未读", body: "x", status: "sent", userId: 1, createdAt: old },
      // 角色定向（userId 为空）：readAt 可能是 admin 读的，**不得**据此删除
      { channel: "in_app", title: "定向pmc-被admin读过", body: "x", status: "sent", targetRole: "pmc", readAt: old, createdAt: old },
    ]);

    const r = await runHousekeeping(db);
    expect(r.notificationsDeleted).toBe(1); // 只删定向个人且已读超期的那一条

    const left = await db.select({ title: notifications.title }).from(notifications);
    expect(new Set(left.map((x) => x.title))).toEqual(
      new Set(["定向-近期已读", "定向-老的未读", "定向pmc-被admin读过"]),
    );
  });
});

/**
 * 读模型缓存保留期：口径升版（key 带 /vN）后旧键再没有读者，行却一直留着。
 * 缓存丢了只会重算，所以按绝对年龄兜底；新鲜的行绝不能被删（那会让驾驶舱当场重算）。
 */
describe("housekeeping 读模型缓存保留期", () => {
  it("删掉超期的旧口径缓存行，保留新鲜行", async () => {
    const { db } = await createTestDb();
    const old = new Date(Date.now() - 90 * 864e5);
    const fresh = new Date(Date.now() - 2 * 864e5);
    await db.insert(reportReadModelCache).values([
      { key: "inventory-alerts/v1", sourceBinding: "b", payload: {}, builtAt: old },
      { key: "inventory-alerts/v2", sourceBinding: "b", payload: {}, builtAt: fresh },
    ]);

    const r = await runHousekeeping(db);
    expect(r.readModelCacheDeleted).toBe(1);

    const left = await db.select({ key: reportReadModelCache.key }).from(reportReadModelCache);
    expect(left.map((x) => x.key)).toEqual(["inventory-alerts/v2"]);
  });
});
