import { describe, expect, it } from "vitest";

import {
  currentProductAutomation,
  evaluateProductSourceEvidence,
  evaluateProductSupportingEvidence,
} from "@/components/data-product-source-evidence";
import type { DataProductDefinition } from "@/components/data-products";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { CROSS_SYSTEM_IDENTITY_LABEL } from "@/lib/cross-system-identity";

function stream(
  key: string,
  overrides: Partial<DataSourceReadiness["streams"][number]> = {},
): DataSourceReadiness["streams"][number] {
  return {
    stream: key,
    latestStatus: "succeeded",
    latestRunAt: "2026-08-12T01:00:00.000Z",
    lastSuccessAt: "2026-08-12T01:00:00.000Z",
    sourceAsOf: "2026-08-11",
    sourceRows: 1,
    stagedRows: 1,
    rejectedRows: 0,
    authorizationBlocked: false,
    sourceTimeInvalid: false,
    releaseBlocked: false,
    schemaDrift: false,
    emptySource: false,
    freshnessMaxAgeDays: 2,
    businessAgeDays: 1,
    pipelineAgeHours: 3,
    freshness: "current",
    ...overrides,
  };
}

function source(
  key: DataSourceReadiness["key"],
  state: DataSourceReadiness["state"],
  successfulStreamKeys: string[],
): DataSourceReadiness {
  return {
    key,
    label: key,
    state,
    configured: true,
    enabled: true,
    configurationReady: true,
    configurationBinding: `test:${key}`,
    contractSelectionState: "selected",
    selectedContractCount: 1,
    successfulStreams: successfulStreamKeys.length,
    successfulStreamKeys,
    streams: successfulStreamKeys.map((key) => stream(key)),
    latestFailedStreams: 0,
    latestRunningStreams: 0,
    sourceRows: 1,
    stagedRows: 1,
    rejectedRows: 0,
    latestRunAt: null,
    lastSuccessAt: null,
    sourceAsOfStart: null,
    sourceAsOfEnd: null,
    openIdentityExceptions: 0,
    observedIdentities: 1,
    identityCoverage: [],
    scmEvidence: key === "SCM" ? {
      "sku-master": {
        rows: 1,
        asOf: null,
        freshnessMaxAgeDays: null,
        businessAgeDays: null,
        freshness: "current",
      },
    } : {},
    gate: "gate",
    nextAction: "next",
  };
}

const product: DataProductDefinition = {
  id: "demand-pulse-test",
  title: "需求脉搏测试",
  decision: "test",
  grain: "day x sku",
  owner: "test",
  ownerRoles: ["pmc"],
  contractVersion: "1.0.0",
  cadence: "daily",
  decisionSlaHours: 24,
  metricIds: ["externalNetDemand"],
  maxAutomation: "A2",
  automationGuardrail: "test",
  sources: ["SCM", "JST"],
  requiredScmEvidence: ["sku-master"],
  requiredStreams: { JST: ["outbound-sales-daily"] },
  requiredIdentities: {},
  targetAuthority: "operational",
  releaseGate: "test",
};

describe("数据产品所需流证据", () => {
  it("数据流全部当前时，缺失或部分统一的身份仍必须保持 A0", () => {
    const identityProduct = {
      ...product,
      requiredIdentities: { JST: ["warehouse"] },
    } satisfies DataProductDefinition;
    const jst = source("JST", "observation", ["outbound-sales-daily"]);
    jst.identityCoverage = [{
      domain: "warehouse",
      label: CROSS_SYSTEM_IDENTITY_LABEL.warehouse,
      governance: "scoped_alias",
      state: "partial",
      observed: 10,
      governed: 8,
      open: 2,
      ignored: 0,
      coveragePct: 80,
      reason: "仍有 2 个仓库待认领",
      nextAction: "人工认领后重跑",
    }];

    const summary = evaluateProductSourceEvidence(identityProduct, [
      source("SCM", "operational", []),
      jst,
    ]);
    expect(summary).toMatchObject({
      partialIdentities: 1,
      missingIdentities: 0,
      unimplementedIdentities: 0,
      identityGates: [expect.objectContaining({ source: "JST", domain: "warehouse", state: "partial" })],
    });
    expect(currentProductAutomation(summary)).toMatchObject({
      level: "A0",
      reason: expect.stringContaining("仓库」身份门禁未通过"),
    });

    jst.identityCoverage[0] = { ...jst.identityCoverage[0], state: "ready", governed: 10, open: 0, coveragePct: 100 };
    expect(currentProductAutomation(evaluateProductSourceEvidence(identityProduct, [
      source("SCM", "operational", []),
      jst,
    ])).level).toBe("A1");
  });

  it("辅助证据可用于产品内回查，但不会改变必需流门禁或自动化级别", () => {
    const withSupporting = {
      ...product,
      supportingStreams: { JIANDAOYUN: ["inventory-count-observation"] },
    } satisfies DataProductDefinition;
    const jdy = source("JIANDAOYUN", "observation", ["inventory-count-observation"]);
    jdy.streams = [stream("inventory-count-observation", {
      freshness: "stale",
      businessAgeDays: 30,
    })];
    const required = evaluateProductSourceEvidence(withSupporting, [
      source("SCM", "operational", []),
      source("JST", "observation", ["outbound-sales-daily"]),
      jdy,
    ]);
    const supporting = evaluateProductSupportingEvidence(withSupporting, [jdy]);

    expect(supporting).toEqual([
      expect.objectContaining({
        source: "JIANDAOYUN",
        stream: "inventory-count-observation",
        state: "stale",
      }),
    ]);
    expect(required.sources.map((row) => row.source)).toEqual(["SCM", "JST"]);
    expect(currentProductAutomation(required).level).toBe("A1");
  });

  it("历史手工演练成功不能代替当前部署契约选择", () => {
    const scm = source("SCM", "operational", []);
    const jst = source("JST", "observation", ["outbound-sales-daily"]);
    jst.selectedStreamKeys = [];
    jst.streams = jst.streams.map((item) => ({ ...item, selectedForSync: false }));

    const result = evaluateProductSourceEvidence(product, [scm, jst]);

    expect(result.sources.find((item) => item.source === "JST")).toMatchObject({
      state: "degraded",
      degradedStreams: ["outbound-sales-daily"],
      streams: [expect.objectContaining({
        state: "degraded",
        reason: expect.stringContaining("当前部署未显式选中"),
      })],
    });
    expect(currentProductAutomation(result).level).toBe("A0");
  });

  it("不用同连接器的无关成功流代替产品所需流", () => {
    const result = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      source("JST", "observation", ["inventory-total-delta"]),
    ]);

    expect(result).toMatchObject({
      observedSources: 1,
      operationalSources: 1,
      missingSources: 1,
      missingStreams: 1,
    });
    expect(result.sources[1]).toMatchObject({
      source: "JST",
      state: "missing",
      missingStreams: ["outbound-sales-daily"],
    });
  });

  it("只在所需流成功且连接器通过状态门时计入观察或放行", () => {
    const observed = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      source("JST", "observation", ["outbound-sales-daily"]),
    ]);
    expect(observed).toMatchObject({ observedSources: 2, operationalSources: 1, missingStreams: 0 });

    const operational = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      source("JST", "operational", ["outbound-sales-daily"]),
    ]);
    expect(operational).toMatchObject({ observedSources: 2, operationalSources: 2, missingStreams: 0 });
    expect(operational.businessTimeWindow).toEqual({
      timeSensitiveStreams: 1,
      datedStreams: 1,
      undatedStreams: 0,
      commonAsOf: "2026-08-11",
      latestAsOf: "2026-08-11",
      spanDays: 0,
      state: "complete",
    });
  });

  it("计算多源共同可比截止与时点跨度，不用运行时间冒充业务日期", () => {
    const multiSourceProduct = {
      ...product,
      sources: ["SCM", "JST", "YONYOU"],
      requiredStreams: {
        JST: ["outbound-sales-daily"],
        YONYOU: ["yonbip-scm-purchaseorder-list"],
      },
    } satisfies DataProductDefinition;
    const jst = source("JST", "observation", ["outbound-sales-daily"]);
    jst.streams = [stream("outbound-sales-daily", { sourceAsOf: "2026-08-10" })];
    const yonyou = source("YONYOU", "observation", ["yonbip-scm-purchaseorder-list"]);
    yonyou.streams = [stream("yonbip-scm-purchaseorder-list", { sourceAsOf: null })];

    const result = evaluateProductSourceEvidence(multiSourceProduct, [
      source("SCM", "operational", []),
      jst,
      yonyou,
    ]);

    expect(result.businessTimeWindow).toEqual({
      timeSensitiveStreams: 2,
      datedStreams: 1,
      undatedStreams: 1,
      commonAsOf: "2026-08-10",
      latestAsOf: "2026-08-10",
      spanDays: 0,
      state: "partial",
    });
    expect(result.sources.find((row) => row.source === "YONYOU")).toMatchObject({
      state: "degraded",
      streams: [expect.objectContaining({ reason: "缺少源业务截止日" })],
    });
    expect(currentProductAutomation(result)).toMatchObject({
      level: "A0",
      reason: expect.stringContaining("缺业务截止日"),
    });

    yonyou.streams = [stream("yonbip-scm-purchaseorder-list", { sourceAsOf: "2026-08-13" })];
    expect(evaluateProductSourceEvidence(multiSourceProduct, [
      source("SCM", "operational", []),
      jst,
      yonyou,
    ]).businessTimeWindow).toMatchObject({
      commonAsOf: "2026-08-10",
      latestAsOf: "2026-08-13",
      spanDays: 3,
      state: "complete",
    });
  });

  it("过期、最近失败和拒收证据不能把数据产品提升为已放行", () => {
    const staleJst = source("JST", "operational", ["outbound-sales-daily"]);
    staleJst.streams = [stream("outbound-sales-daily", {
      freshness: "stale",
      businessAgeDays: 4,
    })];
    const stale = evaluateProductSourceEvidence(product, [source("SCM", "operational", []), staleJst]);
    expect(stale).toMatchObject({ observedSources: 1, operationalSources: 1, staleStreams: 1 });
    expect(stale.sources[1]).toMatchObject({ state: "stale", staleStreams: ["outbound-sales-daily"] });

    const failedJst = source("JST", "operational", ["outbound-sales-daily"]);
    failedJst.streams = [stream("outbound-sales-daily", {
      latestStatus: "failed",
      rejectedRows: 2,
    })];
    const degraded = evaluateProductSourceEvidence(product, [source("SCM", "operational", []), failedJst]);
    expect(degraded).toMatchObject({ observedSources: 2, operationalSources: 1, degradedStreams: 1 });
    expect(degraded.sources[1]).toMatchObject({ state: "degraded" });

    const yonyouProduct = {
      ...product,
      sources: ["SCM", "YONYOU"],
      requiredStreams: { YONYOU: ["yonbip-scm-purchaseorder-list"] },
    } satisfies DataProductDefinition;
    const deniedYonyou = source("YONYOU", "operational", ["yonbip-scm-purchaseorder-list"]);
    deniedYonyou.streams = [stream("yonbip-scm-purchaseorder-list", {
      authorizationBlocked: true,
      freshness: "unknown",
    })];
    const denied = evaluateProductSourceEvidence(yonyouProduct, [
      source("SCM", "operational", []),
      deniedYonyou,
    ]);
    expect(denied).toMatchObject({ observedSources: 2, operationalSources: 1, degradedStreams: 1 });
    expect(denied.sources[1]).toMatchObject({
      state: "degraded",
      streams: [expect.objectContaining({ reason: "源系统授权被阻断；时效门限或源时点不完整" })],
    });
  });

  it("旧标签页缓存没有流列表时安全降级，不崩页也不误放行", () => {
    const legacyJst = source("JST", "observation", []);
    delete (legacyJst as Partial<DataSourceReadiness>).successfulStreamKeys;
    delete (legacyJst as Partial<DataSourceReadiness>).streams;
    const result = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      legacyJst,
    ]);

    expect(result).toMatchObject({ observedSources: 1, missingSources: 1, missingStreams: 1 });
  });

  it("运行证据只解锁 A0/A1，不绕过产品级 UAT 升到目标 A2/A3", () => {
    const safeObservation = source("JST", "observation", ["outbound-sales-daily"]);
    safeObservation.streams = [stream("outbound-sales-daily", { releaseBlocked: true })];
    const explanation = currentProductAutomation(evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      safeObservation,
    ]));
    expect(explanation).toMatchObject({ level: "A1" });

    const qualityReview = source("JST", "observation", ["outbound-sales-daily"]);
    qualityReview.streams = [stream("outbound-sales-daily", {
      quality: {
        status: "review",
        activeRows: 10,
        deletedRows: 0,
        missingFieldValues: 1,
        missingBusinessKeyRows: 0,
        duplicateKeyGroups: 2,
        duplicateRows: 5,
        invalidNumericValues: 0,
        reconciliationMismatchedRows: 1,
        reconciliationInsufficientRows: 0,
      },
    })];
    const qualitySummary = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      qualityReview,
    ]);
    expect(qualitySummary.sources[1]).toMatchObject({
      state: "degraded",
      streams: [expect.objectContaining({
        reason: expect.stringContaining("业务键重复 2 组/5 行"),
      })],
    });
    expect(currentProductAutomation(qualitySummary)).toMatchObject({ level: "A0" });

    const missingScm = source("SCM", "operational", []);
    missingScm.scmEvidence = {};
    const missingScmSummary = evaluateProductSourceEvidence(product, [
      missingScm,
      safeObservation,
    ]);
    expect(missingScmSummary.sources[0]).toMatchObject({
      state: "missing",
      missingStreams: ["sku-master"],
    });
    expect(currentProductAutomation(missingScmSummary)).toMatchObject({ level: "A0" });

    const stalePlanningProduct = {
      ...product,
      requiredScmEvidence: ["planning-lines"],
    } satisfies DataProductDefinition;
    const staleScm = source("SCM", "operational", []);
    staleScm.scmEvidence = {
      "planning-lines": {
        rows: 12,
        asOf: "2026-07-01",
        freshnessMaxAgeDays: 8,
        businessAgeDays: 42,
        freshness: "stale",
      },
    };
    const staleScmSummary = evaluateProductSourceEvidence(stalePlanningProduct, [
      staleScm,
      safeObservation,
    ]);
    expect(staleScmSummary.sources[0]).toMatchObject({
      state: "stale",
      staleStreams: ["planning-lines"],
    });
    expect(currentProductAutomation(staleScmSummary)).toMatchObject({ level: "A0" });

    const invalidated = source("JST", "observation", ["outbound-sales-daily"]);
    invalidated.configurationReady = false;
    expect(currentProductAutomation(evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      invalidated,
    ]))).toMatchObject({ level: "A0" });

    for (const connectorState of ["contract_only", "blocked"] as const) {
      const historicalSuccess = source("JST", connectorState, ["outbound-sales-daily"]);
      historicalSuccess.configurationReady = true;
      const summary = evaluateProductSourceEvidence(product, [
        source("SCM", "operational", []),
        historicalSuccess,
      ]);
      expect(summary.sources[1]).toMatchObject({ connectorState });
      expect(currentProductAutomation(summary)).toMatchObject({ level: "A0" });
    }

    const rejected = source("JST", "operational", ["outbound-sales-daily"]);
    rejected.streams = [stream("outbound-sales-daily", { rejectedRows: 1 })];
    expect(currentProductAutomation(evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      rejected,
    ]))).toMatchObject({ level: "A0" });

    const empty = source("JST", "operational", ["outbound-sales-daily"]);
    empty.streams = [stream("outbound-sales-daily", { sourceRows: 0, stagedRows: 0, emptySource: true })];
    const emptySummary = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      empty,
    ]);
    expect(emptySummary.sources[1]).toMatchObject({
      state: "degraded",
      streams: [expect.objectContaining({ reason: "源端返回 0 行，尚无业务证据" })],
    });
    expect(currentProductAutomation(emptySummary)).toMatchObject({ level: "A0" });

    expect(currentProductAutomation(evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      source("JST", "operational", ["outbound-sales-daily"]),
    ]))).toMatchObject({ level: "A1" });
    expect(product.maxAutomation).toBe("A2");
  });

  it("把外部字段结构漂移解释为契约评审阻断，而不是普通观察限制", () => {
    const drifting = source("JST", "observation", ["outbound-sales-daily"]);
    drifting.streams = [stream("outbound-sales-daily", {
      schemaDrift: true,
      releaseBlocked: true,
    })];
    const result = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      drifting,
    ]);
    expect(result.sources[1].streams[0]).toMatchObject({
      state: "degraded",
      reason: "外部字段结构变化，待契约评审",
    });
    expect(currentProductAutomation(result)).toMatchObject({
      level: "A0",
      reason: expect.stringContaining("结构漂移"),
    });
  });
});
