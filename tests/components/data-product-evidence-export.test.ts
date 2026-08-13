import { describe, expect, it } from "vitest";

import { buildDataProductEvidenceExport } from "@/components/data-product-evidence-export";
import type { DataProductDefinition } from "@/components/data-products";
import type { DataSourceReadiness, DataStreamEvidence } from "@/server/modules/report/data-source-readiness";

function stream(key: string, sourceAsOf: string): DataStreamEvidence {
  return {
    stream: key,
    latestStatus: "succeeded",
    latestRunAt: "2026-08-13T01:00:00.000Z",
    lastSuccessAt: "2026-08-13T01:01:00.000Z",
    sourceAsOf,
    sourceRows: 12,
    stagedRows: 12,
    rejectedRows: 0,
    authorizationBlocked: false,
    sourceTimeInvalid: false,
    releaseBlocked: true,
    schemaDrift: false,
    emptySource: false,
    freshnessMaxAgeDays: 2,
    businessAgeDays: 1,
    pipelineAgeHours: 2,
    freshness: "current",
  };
}

function source(key: "JST" | "YONYOU", row: DataStreamEvidence): DataSourceReadiness {
  return {
    key,
    label: key,
    state: "observation",
    configured: true,
    enabled: true,
    configurationReady: true,
    configurationBinding: `must-not-export:${key}`,
    contractSelectionState: "selected",
    selectedContractCount: 1,
    successfulStreams: 1,
    successfulStreamKeys: [row.stream],
    streams: [row],
    latestFailedStreams: 0,
    latestRunningStreams: 0,
    sourceRows: row.sourceRows,
    stagedRows: row.stagedRows,
    rejectedRows: row.rejectedRows,
    latestRunAt: row.latestRunAt,
    lastSuccessAt: row.lastSuccessAt,
    sourceAsOfStart: row.sourceAsOf,
    sourceAsOfEnd: row.sourceAsOf,
    openIdentityExceptions: 0,
    observedIdentities: 12,
    scmEvidence: {},
    gate: "gate",
    nextAction: "next",
  };
}

const product: DataProductDefinition = {
  id: "triangulation-test",
  title: "三方核对测试",
  decision: "哪里不一致？",
  grain: "日 × SKU",
  owner: "数据 / 财务",
  ownerRoles: ["finance"],
  contractVersion: "1.0.0",
  cadence: "daily",
  decisionSlaHours: 24,
  metricIds: ["inventoryReconciliationGap"],
  maxAutomation: "A2",
  automationGuardrail: "只定位，不调平",
  sources: ["JST", "YONYOU"],
  requiredScmEvidence: [],
  requiredStreams: { JST: ["sales"], YONYOU: ["voucher"] },
  targetAuthority: "financial",
  releaseGate: "test",
};

describe("三方数据产品决策证据导出", () => {
  it("逐产品逐流导出共同截止、责任动作和技术回查键，不泄露连接指纹", () => {
    const result = buildDataProductEvidenceExport([
      product,
    ], [
      source("JST", stream("sales", "2026-08-10")),
      source("YONYOU", stream("voucher", "2026-08-12")),
    ], [], new Date("2026-08-13T02:03:04.000Z"));

    expect(result.filename).toBe("三方数据-产品决策证据-2026-08-13T02-03-04-000Z.csv");
    expect(result.rows).toHaveLength(2);
    const asObjects = result.rows.map((row) => Object.fromEntries(
      result.headers.map((header, index) => [header, row[index]]),
    ));
    expect(asObjects).toEqual([
      expect.objectContaining({
        数据产品ID: "triangulation-test",
        来源技术键: "JST",
        数据流技术键: "sales",
        共同可比截止: "2026-08-10",
        最新来源日期: "2026-08-12",
        跨源时点跨度天数: 2,
        处置阶段: "可验收放行",
        当前有效级别: "A1",
      }),
      expect.objectContaining({
        来源技术键: "YONYOU",
        数据流技术键: "voucher",
        观察层阻断: "是",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-export");
  });
});
