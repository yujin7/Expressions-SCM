import { describe, expect, it } from "vitest";

import { evaluateProductSourceEvidence } from "@/components/data-product-source-evidence";
import type { DataProductDefinition } from "@/components/data-products";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";

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
  sources: ["SCM", "JST"],
  requiredStreams: { JST: ["outbound-sales-daily"] },
  targetAuthority: "operational",
  releaseGate: "test",
};

describe("数据产品所需流证据", () => {
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
});
