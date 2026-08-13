import { describe, expect, it } from "vitest";

import { buildDataProductEvidenceExport } from "@/components/data-product-evidence-export";
import type { DataProductDefinition } from "@/components/data-products";
import type { DataSourceReadiness, DataStreamEvidence } from "@/server/modules/report/data-source-readiness";
import type { DataProductOutcomeReadiness } from "@/server/modules/report/data-product-outcome";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";
import { CROSS_SYSTEM_IDENTITY_LABEL } from "@/lib/cross-system-identity";

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
    identityCoverage: key === "JST" ? [{
      domain: "warehouse",
      label: CROSS_SYSTEM_IDENTITY_LABEL.warehouse,
      governance: "scoped_alias",
      state: "ready",
      observed: 5,
      governed: 5,
      open: 0,
      ignored: 0,
      coveragePct: 100,
      reason: "已精确认领",
      nextAction: "持续监测",
    }] : key === "YONYOU" ? [{
      domain: "organization",
      label: CROSS_SYSTEM_IDENTITY_LABEL.organization,
      governance: "planned_master",
      state: "not_implemented",
      observed: 0,
      governed: 0,
      open: 0,
      ignored: 0,
      coveragePct: null,
      reason: "组织主档待建",
      nextAction: "按租户+组织 ID 建立映射",
    }] : [],
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
  requiredStreams: {
    JST: ["outbound-sales-daily"],
    YONYOU: ["yonbip-fi-ficloud-openapi-voucher-queryvouchers"],
  },
  requiredIdentities: { JST: ["warehouse"], YONYOU: ["organization"] },
  requiredSemantics: {
    JST: { "outbound-sales-daily": ["grain", "quantity_unit"] },
    YONYOU: { "yonbip-fi-ficloud-openapi-voucher-queryvouchers": ["grain", "currency"] },
  },
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

const supportingObservation: JiandaoyunSupportingObservation = {
  stream: "inventory-count-observation",
  authority: "historical_observation",
  runId: 10,
  importJobId: 20,
  sourceAsOf: "2024-07-22",
  businessDateFrom: "2024-07-20",
  businessDateThrough: "2024-07-22",
  rows: 2,
  metrics: [{ key: "loss", label: "盘亏数量", value: "3.0000", unit: "" }],
  identityCoverage: [{
    kind: "warehouse",
    label: "仓库身份",
    distinctValues: 2,
    governedMatches: 0,
    openValues: 2,
    queuedValues: 1,
    unqueuedValues: 1,
  }],
  summary: "盘点单 2单 · 盘亏数量 3",
  gate: "历史辅助观察：不参与产品放行。",
};

const release: DataProductReleaseReadiness = {
  productId: product.id,
  runtimeLevel: "A0",
  effectiveLevel: "A0",
  eligibleForRequest: false,
  gate: "上游未满足",
  currentScopeDigest: "must-not-export:current-scope",
  activeRelease: null,
  pendingRelease: null,
  latestRelease: null,
  activeReleaseCurrent: false,
  canRequest: false,
  canApprove: false,
  canReject: false,
  canRevoke: false,
  dependencyGates: [{
    productId: "upstream-test",
    title: "上游基线",
    minimumLevel: "A2",
    effectiveLevel: "A1",
    activeReleaseCurrent: false,
    satisfied: false,
    purpose: "复用上游口径",
  }],
};

describe("三方数据产品决策证据导出", () => {
  it("逐产品逐流导出共同截止、责任动作和技术回查键，不泄露连接指纹", () => {
    const result = buildDataProductEvidenceExport([
      product,
    ], [
      source("JST", stream("outbound-sales-daily", "2026-08-10", {
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
      source("YONYOU", stream("yonbip-fi-ficloud-openapi-voucher-queryvouchers", "2026-08-12")),
      source("JIANDAOYUN", stream("inventory-count-observation", "2026-07-01", {
        freshness: "stale",
        businessAgeDays: 43,
      })),
    ], [release], [outcome], new Date("2026-08-13T02:03:04.000Z"), [supportingObservation]);

    expect(result.filename).toBe("三方数据-产品决策证据-2026-08-13T02-03-04-000Z.csv");
    expect(result.rows).toHaveLength(5);
    const asObjects = result.rows.map((row) => Object.fromEntries(
      result.headers.map((header, index) => [header, row[index]]),
    ));
    expect(asObjects).toEqual([
      expect.objectContaining({
        数据产品ID: "triangulation-test",
        证据用途: "放行依赖",
        来源技术键: "JST",
        数据流技术键: "outbound-sales-daily",
        共同可比截止: "2026-08-10",
        最新来源日期: "2026-08-12",
        跨源时点跨度天数: 2,
        处置阶段: "修复证据",
        当前有效级别: "A0",
        上游产品门禁: "上游基线≥A2:未满足(当前A1)",
        未满足上游产品数: 1,
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
        业务语义门禁: "business_review_pending",
        源业务粒度: "业务日 × 聚水潭仓库 × SKU",
        本产品使用语义: "业务粒度[implemented]；数量单位[business_review_pending]",
      }),
      expect.objectContaining({
        来源技术键: "YONYOU",
        证据用途: "放行依赖",
        数据流技术键: "yonbip-fi-ficloud-openapi-voucher-queryvouchers",
        观察层阻断: "是",
        业务语义门禁: "schema_profile_pending",
        本产品使用语义: "币种[schema_profile_pending]；业务粒度[schema_profile_pending]",
      }),
      expect.objectContaining({
        来源技术键: "JIANDAOYUN",
        证据用途: "辅助证据（不参与放行）",
        数据流技术键: "inventory-count-observation",
        流证据状态: "stale",
        共同可比截止: "2026-08-10",
        辅助历史摘要: "盘点单 2单 · 盘亏数量 3",
        辅助历史期间: "2024-07-20 至 2024-07-22",
        辅助身份认领覆盖: "仓库身份 0/2（待认领 2，已入队 1，未入队 1）",
      }),
      expect.objectContaining({
        记录类型: "data_product_identity_evidence",
        证据用途: "身份门禁",
        来源技术键: "JST",
        数据流技术键: "identity:warehouse",
        身份维度: "仓库",
        身份治理方式: "scoped_alias",
        身份状态: "ready",
        身份候选数: 5,
        身份已认领数: 5,
        身份提取契约状态: "implemented",
        身份适用数据流: "聚水潭日出库销量[implemented]",
      }),
      expect.objectContaining({
        证据用途: "身份门禁",
        来源技术键: "YONYOU",
        数据流技术键: "identity:organization",
        身份维度: "组织",
        身份状态: "not_implemented",
        身份下一步: "按租户+组织 ID 建立映射",
        身份提取契约状态: "schema_profile_pending",
        身份适用数据流: "用友财务凭证[schema_profile_pending]",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-export");
    expect(JSON.stringify(result)).not.toContain("internal-evidence-7");
  });
});
