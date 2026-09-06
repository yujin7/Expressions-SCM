import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectorRunState, connectorRuntimeState, JobRunState } from "@/app/(app)/admin/health/health-client";
import type { OpsHealth } from "@/server/modules/admin/health";
import { yonyouJobSummary } from "@/lib/yonyou-job-summary";

type RunRow = OpsHealth["connectorRuns"][number];

function run(overrides: Partial<RunRow>): RunRow {
  return {
    runId: 1,
    connector: "jdy",
    stream: "product-master-observation",
    status: "succeeded",
    startedAt: "2026-08-02T00:00:00.000Z",
    finishedAt: "2026-08-02T00:01:00.000Z",
    sourceRows: 8,
    stagedRows: 8,
    rejectedRows: 0,
    sourceAsOf: "2026-08-01",
    schemaHashPrefix: "abc123",
    unresolvedAliases: 0,
    openScopedAliasExceptions: 0,
    checkpointVersion: 3,
    checkpointLastSuccessAt: "2026-08-02T00:01:00.000Z",
    checkpointAgeHours: 1,
    checkpointOnLatestRun: true,
    emptySource: false,
    releaseBlocked: false,
    schemaDrift: false,
    fieldProfile: null,
    errorSummary: null,
    ...overrides,
  };
}

describe("connector run state rendering", () => {
  it("历史 succeeded 授权等待显示橙色等待，不显示成功", () => {
    const html = renderToStaticMarkup(createElement(ConnectorRunState, { row: run({ authorizationBlocked: true }) }));
    expect(html).toContain("等待授权");
    expect(html).not.toContain("成功");
    expect(html).not.toContain("ant-tag-red");
  });

  it("一成功一等待的总状态分别计数，不声称全部成功", () => {
    const html = renderToStaticMarkup(connectorRuntimeState([run({}), run({ authorizationBlocked: true })]));
    expect(html).toContain("1 条数据流等待授权");
    expect(html).toContain("1 条数据流最近成功");
    expect(html).not.toContain("2 条数据流最近成功");
  });

  it("混合结果显示待核对并排除绿色成功汇总，等待标记优先", () => {
    const inconsistent = run({ resultInconsistent: true });
    expect(renderToStaticMarkup(createElement(ConnectorRunState, { row: inconsistent }))).toContain("结果待核对");
    const html = renderToStaticMarkup(connectorRuntimeState([inconsistent, run({})]));
    expect(html).toContain("1 条数据流结果待核对");
    expect(html).toContain("1 条数据流最近成功");
    expect(html).not.toContain("2 条数据流最近成功");
    const waiting = renderToStaticMarkup(createElement(ConnectorRunState, { row: run({ authorizationBlocked: true, resultInconsistent: true }) }));
    expect(waiting).toContain("等待授权");
    expect(waiting).not.toContain("结果待核对");
  });

  it.each([
    { flags: [true], label: "等待授权" },
    { flags: [false, true], label: "部分完成" },
    { flags: [false], label: "读取完成" },
  ])("任务运行健康为 true 时仍显示实际 $label", ({ flags, label }) => {
    const outcome = yonyouJobSummary({ status: "succeeded", results: flags.map((blockedByConsoleGrant, i) => ({
      runId: i + 1, importJobId: blockedByConsoleGrant ? null : i + 1,
      sourceRows: blockedByConsoleGrant ? 0 : 1500, stagedRows: blockedByConsoleGrant ? 0 : 1500,
      replayed: false, blockedByConsoleGrant,
    })), awaitingConsoleGrant: flags.filter(Boolean).map(() => "合成契约") });
    const html = renderToStaticMarkup(createElement(JobRunState, { row: {
      job: "sync-yonyou", ok: true, message: "", startedAt: "", finishedAt: "", outcome,
    } }));
    expect(html).toContain(label);
    expect(html).not.toContain("成功");
  });

  it("历史未知不伪成功，真实执行失败仍为失败", () => {
    const row = { job: "sync-yonyou", ok: true, message: "", startedAt: "", finishedAt: "", outcome: yonyouJobSummary(null) };
    expect(renderToStaticMarkup(createElement(JobRunState, { row }))).toContain("结果未确认");
    expect(renderToStaticMarkup(createElement(JobRunState, { row: { ...row, ok: false } }))).toContain("失败");
  });

  it("keeps release safety state visible alongside a failed run", () => {
    const html = renderToStaticMarkup(createElement(
      ConnectorRunState,
      { row: run({ status: "failed", releaseBlocked: true }) },
    ));
    expect(html).toContain("失败");
    expect(html).toContain("仅观察，不可放行");
  });

  it("keeps empty-source retention visible alongside a running state", () => {
    const html = renderToStaticMarkup(createElement(
      ConnectorRunState,
      { row: run({ status: "running", emptySource: true }) },
    ));
    expect(html).toContain("运行中");
    expect(html).toContain("空观察，旧批次保留");
  });

  it("shows schema drift as the specific hard release blocker", () => {
    const html = renderToStaticMarkup(createElement(
      ConnectorRunState,
      { row: run({ schemaDrift: true, releaseBlocked: true }) },
    ));
    expect(html).toContain("字段结构变化，阻止放行");
    expect(html).not.toContain("仅观察，不可放行");
  });
});
