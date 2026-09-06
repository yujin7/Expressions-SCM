import { describe, it, expect, beforeAll, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { jobRuns } from "@/db/schema";
import { parseYonyouJobSummary, yonyouJobSummary, YONYOU_JOB_SUMMARY_VERSION } from "@/lib/yonyou-job-summary";
import { runJobFailureWatchdog } from "@/jobs/job-failure-watchdog";
import { TaskDiagnosticError, taskFailureMessage } from "@/jobs/task-diagnostic";
import {
  ensureIntervalJobsStarted,
  INTERVAL_JOBS,
  runIntervalJobOnce,
  runNamedIntervalJobOnce,
} from "@/jobs/interval-runner";

const observation = (blocked: boolean, id = 1) => ({
  runId: id, importJobId: blocked ? null : id, sourceRows: blocked ? 0 : 1250,
  stagedRows: blocked ? 0 : 1250, replayed: false, blockedByConsoleGrant: blocked,
});

describe("interval-runner 进程内调度回退", () => {
  it("保留应用生成的分流控制总量与失败键，不记录 AggregateError 的原始上游 cause", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const summary = "简道云同步未全部完成：成功 2/3 流，失败 1 流；失败流：product-master";
    try {
      const error = new TaskDiagnosticError([new Error("SYNTH_CAUSE_SECRET")], summary);
      expect(taskFailureMessage("sync-jiandaoyun-forms", error, "testid")).toContain(summary);
      const result = await runIntervalJobOnce({ name: "sync-jiandaoyun-forms", everyMs: 1,
        run: async () => { throw error; } }, db);
      expect(result.ok).toBe(false);
      expect(result.message).toContain(summary);
      expect(JSON.stringify([result, output.mock.calls])).not.toContain("SYNTH_CAUSE_SECRET");
      // A plain AggregateError is not a trusted application diagnostic.
      expect(taskFailureMessage("probe-feishu-chats", new AggregateError([], "SYNTH_RAW"), "testid")).not.toContain("SYNTH_RAW");
    } finally { output.mockRestore(); }
  });

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

  it("注册了 35 个任务（含只读权限探测、三方观察、门禁看门狗、rollup、告警结果核验与决策摘要、采购与质量告警）", () => {
    expect(INTERVAL_JOBS.map((j) => j.name).sort()).toEqual([
      "alert-outcome",
      "data-freshness",
      "data-product-gate-watchdog",
      "decision-digest",
      "doc-aging",
      "exception-notify",
      "goals-auto-actuals",
      "housekeeping",
      "inventory-cover-watchdog",
      "inventory-position-refresh",
      "job-failure-watchdog",
      "jst-token-watchdog",
      "license-alert",
      "notify-dispatch",
      "planning-policy-build",
      "probe-jst-permissions",
      "probe-yonyou-permissions",
      "procurement-quality-alerts",
      "purchase-order-metrics",
      "reconcile-jst",
      "rollup",
      "sales-spike-watchdog",
      "snapshot-age",
      "supplier-payment-term",
      "sync-jiandaoyun-catalog",
      "sync-jiandaoyun-forms",
      "sync-jst-inbound",
      "sync-jst-inventory",
      "sync-jst-item-master",
      "sync-jst-sales",
      "sync-yonyou",
      "system-alert-notify",
      "todo-sync",
      "transfer-cost-watchdog",
      "weekly-dq-pack",
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

  it("用友等待授权保留 ok=true；持久化完整有界摘要，多轮等待不触发失败告警", async () => {
    const fixture = await createTestDb();
    try {
      const summary = {
        status: "awaiting_authorization", scopeKey: "NEVER_EXPOSE_SCOPE",
        results: [{ ...observation(true), evidenceHash: "SECRET".repeat(300), error: "NEVER_EXPOSE_ERROR" }],
        awaitingConsoleGrant: ["NEVER_EXPOSE_CONTRACT"],
      };
      for (let i = 0; i < 3; i++) {
        const result = await runIntervalJobOnce({ name: "sync-yonyou", everyMs: 1, run: async () => summary }, fixture.db);
        expect(result.ok).toBe(true);
        expect(result.message.length).toBeLessThan(500);
        expect(JSON.parse(result.message)).toEqual({
          version: YONYOU_JOB_SUMMARY_VERSION, status: "awaiting_authorization", total: 1, readable: 0, waiting: 1,
        });
        expect(result.message).not.toMatch(/NEVER_EXPOSE|SECRET/);
      }
      const rows = await fixture.db.select().from(jobRuns);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.ok)).toBe(true);
      expect(await runJobFailureWatchdog(fixture.db)).toMatchObject({ opened: 0, failingJobs: [] });
    } finally { await fixture.client.close(); }
  });

  it("用友真正执行失败仍 ok=false，日志摘要不保存原始外部错误", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
    const result = await runIntervalJobOnce({
      name: "sync-yonyou", everyMs: 1, run: async () => { throw new Error("token=DO_NOT_PERSIST"); },
    }, db);
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.message)).toEqual({
      version: YONYOU_JOB_SUMMARY_VERSION, status: "failed", total: null, readable: null, waiting: null,
    });
    expect(result.message).not.toContain("DO_NOT_PERSIST");
    expect(JSON.stringify(output.mock.calls)).not.toContain("DO_NOT_PERSIST");
    expect(JSON.stringify(output.mock.calls)).toContain("sync-yonyou");
    } finally { output.mockRestore(); }
  });

  it("外部任务的无标签原始错误不进入控制台或 job_runs；保持失败和关联编号", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await runIntervalJobOnce({ name: "sync-jst-sales", everyMs: 1,
        run: async () => { throw new Error("SYNTH_UNLABELLED_PROVIDER_SECRET"); } }, db);
      expect(result.ok).toBe(false);
      expect(result.recorded).toBe(true);
      const rows = await db.select().from(jobRuns);
      const stored = rows.find((row) => row.job === "sync-jst-sales");
      expect(JSON.stringify([result, stored, output.mock.calls])).not.toContain("SYNTH_UNLABELLED");
      expect(result.message).toContain("错误码");
      expect(output.mock.calls[0][0]).toContain("errorId");
    } finally { output.mockRestore(); }
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

  it("运维恢复同样拒绝紧凑 connector-probe/v1 skipped 证据", async () => {
    const job = {
      name: "manual-compact-probe-skipped-test",
      everyMs: 1,
      run: async () => ({
        v: "connector-probe/v1",
        c: "jst",
        s: "skipped",
        a: "not_checked",
        p: 0,
        t: 6,
        r: Array.from({ length: 6 }, () => "not_checked"),
        b: null,
        w: false,
      }),
    };
    INTERVAL_JOBS.push(job);
    try {
      await expect(runNamedIntervalJobOnce(job.name, db)).rejects.toThrow(
        "Skipped: 连接器权限探测因配置不完整未执行",
      );
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
      // job_locks 的抢锁/释放走 execute（S4 跨调度器互斥）；这里只模拟 job_runs 写失败
      execute: async () => [{ job: job.name }],
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

describe("用友安全摘要兼容与边界", () => {
  it("完整旧摘要中的 succeeded 不覆盖部分授权等待事实", () => {
    const result = parseYonyouJobSummary(JSON.stringify({
      status: "succeeded", results: [observation(false), observation(true, 2)],
      awaitingConsoleGrant: ["存货成本查询"], error: "SECRET",
    }), true);
    expect(result).toEqual({ version: YONYOU_JOB_SUMMARY_VERSION, status: "partial", total: 2, readable: 1, waiting: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each([
    null, "", '{"status":"succeeded","results":[', "{}", "null",
    JSON.stringify({ version: YONYOU_JOB_SUMMARY_VERSION, status: "succeeded", total: 2, readable: 1, waiting: 1 }),
    JSON.stringify({ version: YONYOU_JOB_SUMMARY_VERSION, status: "partial", total: 101, readable: 1, waiting: 100 }),
    JSON.stringify({ status: "succeeded", results: [observation(true)], awaitingConsoleGrant: [] }),
  ])("坏/矛盾/截断证据 %s 保持结果未确认", (message) => {
    expect(parseYonyouJobSummary(message, true)).toMatchObject({ status: "unknown", total: null, readable: null, waiting: null });
  });

  it("白名单重建丢弃额外业务字段，正常完成不会被标为 skipped", () => {
    expect(yonyouJobSummary({
      version: YONYOU_JOB_SUMMARY_VERSION, status: "succeeded", total: 8, readable: 8, waiting: 0,
      raw: "DO_NOT_EXPOSE",
    })).toEqual({ version: YONYOU_JOB_SUMMARY_VERSION, status: "succeeded", total: 8, readable: 8, waiting: 0 });
  });

  it("旧假重放没有观察 job，即使 blocked=false 和 succeeded 也只能结果未确认", () => {
    const message = JSON.stringify({ status: "succeeded", awaitingConsoleGrant: [], results: [{
      runId: 1, importJobId: null, sourceRows: 0, stagedRows: 0, replayed: true, blockedByConsoleGrant: false,
    }] });
    expect(parseYonyouJobSummary(message, true)).toMatchObject({ status: "unknown", readable: null });
  });

  it.each([
    { ...observation(false), runId: 0 },
    { ...observation(false), runId: 2_147_483_648 },
    { ...observation(false), importJobId: 0 },
    { ...observation(false), importJobId: "1" },
    { ...observation(false), sourceRows: -1 },
    { ...observation(false), sourceRows: 1.5 },
    { ...observation(false), sourceRows: Number.MAX_SAFE_INTEGER },
    { ...observation(false), stagedRows: 1251 },
    { ...observation(false), stagedRows: "1250" },
    { ...observation(true), importJobId: 1 },
    { ...observation(true), sourceRows: 1 },
    { ...observation(true), stagedRows: 1 },
  ])("原始证据 ID 或行计数矛盾不得展示成功 %j", (row) => {
    expect(yonyouJobSummary({ status: "succeeded", results: [row], awaitingConsoleGrant: row.blockedByConsoleGrant ? ["成本"] : [] }))
      .toMatchObject({ status: "unknown", readable: null });
  });

  it("业务行数不套用契约数上限；有导入 job 的真实零行及大批次均完成读取", () => {
    for (const size of [0, 125_000, 2_147_483_647]) {
      const row = { ...observation(false), sourceRows: size, stagedRows: size };
      expect(yonyouJobSummary({ status: "succeeded", results: [row], awaitingConsoleGrant: [] }))
        .toMatchObject({ status: "succeeded", total: 1, readable: 1, waiting: 0 });
    }
  });
});
