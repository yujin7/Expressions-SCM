import { describe, expect, it } from "vitest";

import { buildDataProductEvidenceExport } from "@/components/data-product-evidence-export";
import type { DataProductDefinition } from "@/components/data-products";
import type { DataSourceReadiness, DataStreamEvidence } from "@/server/modules/report/data-source-readiness";
import type { DataProductOutcomeReadiness } from "@/server/modules/report/data-product-outcome";

function stream(
  key: string,
  sourceAsOf: string,
  overrides: Partial<DataStreamEvidence> = {},
): DataStreamEvidence {
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
    ...overrides,
  };
}

function source(key: "JIANDAOYUN" | "JST" | "YONYOU", row: DataStreamEvidence): DataSourceReadiness {
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
  supportingStreams: { JIANDAOYUN: ["inventory-count-observation"] },
  targetAuthority: "financial",
  releaseGate: "test",
};

const outcome: DataProductOutcomeReadiness = {
  productId: product.id,
  canRecord: true,
  canCorrect: true,
  gate: "可登记真实结果",
  cashVisible: true,
  outcomeCount: 3,
  evaluatedDecisionCount: 3,
  adoptedCount: 2,
  pendingCount: 0,
  terminalResultCount: 3,
  falsePositiveCount: 1,
  adoptionRatePct: "66.7",
  falsePositiveRatePct: "33.3",
  avgHandlingMinutes: "18.0",
  savedHoursTotal: "7.50",
  cashImpactTotal: "1200.00",
  latest: [{
    id: 7,
    productId: product.id,
    contractVersion: product.contractVersion,
    releaseId: 3,
    sourceEvidenceDigest: "must-not-export:scope-digest",
    decisionRef: "TRI-20260813-001",
    businessDate: "2026-08-13",
    decision: "modified",
    result: "positive",
    handlingMinutes: 18,
    savedHours: "2.50",
    cashImpact: "500.00",
    currency: "CNY",
    cashVisible: true,
    reasonCode: "business_constraint",
    evidenceRef: "internal-evidence-7",
    note: "受约束后执行并形成正向结果",
    supersedesId: null,
    recordedBy: 1,
    recordedByName: "财务",
    createdAt: "2026-08-13T04:00:00.000Z",
  }],
};

describe("三方数据产品决策证据导出", () => {
  it("逐产品逐流导出共同截止、责任动作和技术回查键，不泄露连接指纹", () => {
    const result = buildDataProductEvidenceExport([
      product,
    ], [
      source("JST", stream("sales", "2026-08-10", {
        quality: {
          status: "review",
          activeRows: 12,
          deletedRows: 0,
          missingFieldValues: 2,
          missingBusinessKeyRows: 1,
          duplicateKeyGroups: 2,
          duplicateRows: 5,
          invalidNumericValues: 0,
          reconciliationMismatchedRows: 1,
          reconciliationInsufficientRows: 0,
        },
      })),
      source("YONYOU", stream("voucher", "2026-08-12")),
      source("JIANDAOYUN", stream("inventory-count-observation", "2026-07-01", {
        freshness: "stale",
        businessAgeDays: 43,
      })),
    ], [], [outcome], new Date("2026-08-13T02:03:04.000Z"));

    expect(result.filename).toBe("三方数据-产品决策证据-2026-08-13T02-03-04-000Z.csv");
    expect(result.rows).toHaveLength(3);
    const asObjects = result.rows.map((row) => Object.fromEntries(
      result.headers.map((header, index) => [header, row[index]]),
    ));
    expect(asObjects).toEqual([
      expect.objectContaining({
        数据产品ID: "triangulation-test",
        证据用途: "放行依赖",
        来源技术键: "JST",
        数据流技术键: "sales",
        共同可比截止: "2026-08-10",
        最新来源日期: "2026-08-12",
        跨源时点跨度天数: 2,
        处置阶段: "修复证据",
        当前有效级别: "A0",
        结果学习状态: "已形成真实反馈",
        真实结果有效记录数: 3,
        "采纳率%": "66.7",
        最新结果决策编号: "TRI-20260813-001",
        最新业务决定: "修改后采纳",
        最新真实结果: "正向",
        聚合质量状态: "待复核",
        业务键缺失行: 1,
        重复键组: 2,
        重复键行: 5,
        对账差异行: 1,
      }),
      expect.objectContaining({
        来源技术键: "YONYOU",
        证据用途: "放行依赖",
        数据流技术键: "voucher",
        观察层阻断: "是",
      }),
      expect.objectContaining({
        来源技术键: "JIANDAOYUN",
        证据用途: "辅助证据（不参与放行）",
        数据流技术键: "inventory-count-observation",
        流证据状态: "stale",
        共同可比截止: "2026-08-10",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-export");
    expect(JSON.stringify(result)).not.toContain("internal-evidence-7");
  });
});
