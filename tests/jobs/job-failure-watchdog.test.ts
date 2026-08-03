/**
 * 定时任务连续失败看门狗测试。
 *
 * 背景：job_runs 一直忠实记录成败、/admin/health 也能看，但**没人在失败时被通知**。
 * 对 6 小时一跑的三方同步，这就是"同步三周前挂了没人知道"的来源。
 *
 * 重点钉住：单次/两次失败不告警（三方接口抖动是常态，一有失败就开单会让告警变噪音，
 * 然后所有人开始无视它——比没有告警更糟），连续达阈值才告警，恢复后自动关闭。
 */
import { describe, expect, it } from "vitest";
import { jobRuns, systemAlerts } from "@/db/schema";
import {
  countLeadingFailures,
  runJobFailureWatchdog,
} from "@/jobs/job-failure-watchdog";
import { createTestDb } from "../helpers/db";

const BASE = new Date("2026-08-04T00:00:00Z");

async function seedRuns(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  job: string,
  results: boolean[],
): Promise<void> {
  // results[0] 是最早的一次；finishedAt 递增，最新的在最后
  for (const [index, ok] of results.entries()) {
    const at = new Date(BASE.getTime() + index * 60_000);
    await db.insert(jobRuns).values({
      job,
      ok,
      message: ok ? null : `失败 #${index}`,
      startedAt: at,
      finishedAt: at,
    });
  }
}

describe("定时任务连续失败看门狗", () => {
  it("偶发单次失败不告警——一有失败就开单会让告警沦为噪音", async () => {
    const { db } = await createTestDb();
    await seedRuns(db, "sync-yonyou", [true, false, true]);
    const result = await runJobFailureWatchdog(db);
    expect(result.opened).toBe(0);
    expect(await db.select().from(systemAlerts)).toHaveLength(0);
  });

  it("连续两次失败仍不告警（阈值为 3）", async () => {
    const { db } = await createTestDb();
    await seedRuns(db, "sync-yonyou", [true, false, false]);
    const result = await runJobFailureWatchdog(db);
    expect(result.opened).toBe(0);
  });

  it("连续三次失败开高优告警，并带上最近一次错误信息", async () => {
    const { db } = await createTestDb();
    await seedRuns(db, "sync-jst-sales", [true, false, false, false]);
    const result = await runJobFailureWatchdog(db);

    expect(result.opened).toBe(1);
    expect(result.failingJobs).toEqual(["sync-jst-sales"]);

    const [alert] = await db.select().from(systemAlerts);
    expect(alert.severity).toBe("high");
    expect(alert.refKey).toBe("sync-jst-sales");
    expect(alert.title).toContain("连续失败 3 次");
    expect(alert.detail, "要带上错误原文，否则还得再去翻日志").toContain("失败 #3");
    expect(alert.detail, "三方同步应提示先查凭据/授权").toContain("授权");
  });

  it("同一任务不重复开单", async () => {
    const { db } = await createTestDb();
    await seedRuns(db, "sync-yonyou", [false, false, false]);
    await runJobFailureWatchdog(db);
    const second = await runJobFailureWatchdog(db);
    expect(second.opened).toBe(0);
    expect(await db.select().from(systemAlerts)).toHaveLength(1);
  });

  it("任务恢复成功后自动关闭告警", async () => {
    const { db } = await createTestDb();
    await seedRuns(db, "sync-yonyou", [false, false, false]);
    await runJobFailureWatchdog(db);

    // 之后跑成功了一次
    await db.insert(jobRuns).values({
      job: "sync-yonyou",
      ok: true,
      startedAt: new Date(BASE.getTime() + 600_000),
      finishedAt: new Date(BASE.getTime() + 600_000),
    });
    const after = await runJobFailureWatchdog(db);

    expect(after.autoClosed).toBe(1);
    const [alert] = await db.select().from(systemAlerts);
    expect(alert.status).toBe("resolved");
    expect(alert.autoResolved).toBe(true);
  });

  it("多个任务同时故障时逐个开单，互不影响", async () => {
    const { db } = await createTestDb();
    await seedRuns(db, "sync-yonyou", [false, false, false]);
    await seedRuns(db, "sync-jst-sales", [false, false, false]);
    await seedRuns(db, "rollup", [true, true, true]);

    const result = await runJobFailureWatchdog(db);
    expect(result.opened).toBe(2);
    expect(result.failingJobs).toEqual(["sync-jst-sales", "sync-yonyou"]);
  });

  it("没有任何运行记录时不告警（新部署不该一上来就红）", async () => {
    const { db } = await createTestDb();
    const result = await runJobFailureWatchdog(db);
    expect(result).toMatchObject({ opened: 0, autoClosed: 0, failingJobs: [] });
  });

  it("只数开头的连续失败，早期失败已被后续成功隔断的不计入", () => {
    // 数组按时间倒序传入：最新在前
    expect(countLeadingFailures([{ ok: false }, { ok: false }, { ok: true }, { ok: false }])).toBe(2);
    expect(countLeadingFailures([{ ok: true }, { ok: false }, { ok: false }])).toBe(0);
    expect(countLeadingFailures([])).toBe(0);
  });
});
