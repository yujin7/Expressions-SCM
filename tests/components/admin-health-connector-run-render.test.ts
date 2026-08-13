import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectorRunState } from "@/app/(app)/admin/health/health-client";
import type { OpsHealth } from "@/server/modules/admin/health";

type RunRow = OpsHealth["connectorRuns"][number];

function run(overrides: Partial<RunRow>): RunRow {
  return {
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
