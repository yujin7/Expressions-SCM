import { describe, expect, it } from "vitest";

import { DATA_PRODUCTS, type DataProductDefinition } from "@/components/data-products";
import { buildDataProductWorkQueue } from "@/components/data-product-work-queue";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import type { DataProductOutcomeReadiness } from "@/server/modules/report/data-product-outcome";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";
import { CROSS_SYSTEM_IDENTITY_LABEL } from "@/lib/cross-system-identity";

function currentStream(key: string): DataSourceReadiness["streams"][number] {
  return {
    stream: key,
    latestStatus: "succeeded",
    latestRunAt: "2026-08-14T01:00:00.000Z",
    lastSuccessAt: "2026-08-14T01:00:00.000Z",
    sourceAsOf: "2026-08-14",
    sourceRows: 10,
    stagedRows: 10,
    rejectedRows: 0,
    authorizationBlocked: false,
    sourceTimeInvalid: false,
    releaseBlocked: false,
    schemaDrift: false,
    emptySource: false,
    freshnessMaxAgeDays: 45,
    businessAgeDays: 0,
    pipelineAgeHours: 1,
    freshness: "current",
  };
}

function emptySource(key: DataSourceReadiness["key"]): DataSourceReadiness {
  return {
    key,
    label: key,
    state: key === "SCM" ? "operational" : "contract_only",
    configured: key === "SCM",
    enabled: key === "SCM",
    configurationReady: key === "SCM",
    configurationBinding: `binding:${key}`,
    selectedContractCount: 0,
    contractSelectionState: key === "SCM" ? "not_required" : "missing",
    successfulStreams: 0,
    successfulStreamKeys: [],
    sourceRows: 0,
    stagedRows: 0,
    rejectedRows: 0,
    observedIdentities: key === "SCM" ? null : 0,
    openIdentityExceptions: key === "SCM" ? null : 0,
    identityCoverage: [],
    sourceAsOfStart: null,
    sourceAsOfEnd: null,
    latestRunAt: null,
    lastSuccessAt: null,
    latestFailedStreams: 0,
    latestRunningStreams: 0,
    streams: [],
    scmEvidence: {},
    gate: "待解锁",
    nextAction: "补齐证据",
  };
}

function release(
  productId: string,
  overrides: Partial<DataProductReleaseReadiness> = {},
): DataProductReleaseReadiness {
  return {
    productId,
    runtimeLevel: "A0",
    effectiveLevel: "A0",
    eligibleForRequest: false,
    gate: "待修复",
    currentScopeDigest: "current",
    activeRelease: null,
    pendingRelease: null,
    latestRelease: null,
    activeReleaseCurrent: false,
    canRequest: false,
    canApprove: false,
    canReject: false,
    canRevoke: false,
    dependencyGates: [],
    ...overrides,
  };
}

function outcome(
  productId: string,
  overrides: Partial<DataProductOutcomeReadiness> = {},
): DataProductOutcomeReadiness {
  return {
    productId,
    canRecord: true,
    canCorrect: true,
    gate: "可登记真实结果",
    cashVisible: false,
    outcomeCount: 0,
    evaluatedDecisionCount: 0,
    adoptedCount: 0,
    pendingCount: 0,
    terminalResultCount: 0,
    falsePositiveCount: 0,
    adoptionRatePct: null,
    falsePositiveRatePct: null,
    avgHandlingMinutes: null,
    savedHoursTotal: null,
    cashImpactTotal: null,
    latest: [],
    ...overrides,
  };
}

describe("data product dynamic work queue", () => {
  const sources = (["SCM", "JIANDAOYUN", "JST", "YONYOU"] as const).map(emptySource);

  it("puts a stale active release ahead of ordinary source repairs", () => {
    const product = DATA_PRODUCTS[0];
    const stale = {
      id: 7,
      productId: product.id,
      contractVersion: product.contractVersion,
      targetLevel: "A2" as const,
      sourceEvidenceDigest: "old",
      controlTotalRef: "CT-7",
      uatRef: "UAT-7",
      rollbackPlan: "立即停用建议并恢复人工复核",
      scopeNote: null,
      status: "approved" as const,
      requestedBy: 1,
      requestedByName: "A",
      requestedAt: new Date().toISOString(),
      decidedBy: 2,
      decidedByName: "B",
      decidedAt: new Date().toISOString(),
      decisionNote: "已批准",
      revokedBy: null,
      revokedByName: null,
      revokedAt: null,
      version: 2,
    };
    const queue = buildDataProductWorkQueue(DATA_PRODUCTS, sources, [release(product.id, {
      activeRelease: stale,
      latestRelease: stale,
      canRevoke: true,
    })]);
    expect(queue[0]).toMatchObject({ productId: product.id, stage: "safeguard", blockerState: "release" });
    expect(queue[0].nextAction).toContain("撤回已失效");
    expect(queue[0]).toMatchObject({
      actionLabel: "打开产品门禁",
      actionHref: expect.stringContaining(`product=${product.id}`),
    });
  });

  it("orders ordinary repairs by the declared decision SLA without invented value scores", () => {
    const queue = buildDataProductWorkQueue(DATA_PRODUCTS, sources, []);
    expect(queue.every((item) => item.stage === "repair")).toBe(true);
    expect(queue.map((item) => item.decisionSlaHours)).toEqual(
      [...queue.map((item) => item.decisionSlaHours)].sort((a, b) => a - b),
    );
    expect(queue[0].bottleneck).toContain("尚无成功运行证据");
    expect(queue.find((item) => item.productId === "demand-pulse")?.nextAction).toContain("天猫退款");
    expect(queue.find((item) => item.productId === "demand-pulse")?.nextAction).not.toContain("tmall-sku-refund-observation");
    expect(queue.find((item) => item.productId === "demand-pulse")?.actionLabel).toBe("查看逐流证据");
  });

  it("routes an external identity blocker to the scoped human-claim queue", () => {
    const catalogProduct = DATA_PRODUCTS.find((item) => item.id === "commerce-identity-control")!;
    const product: DataProductDefinition = {
      ...catalogProduct,
      sources: ["SCM", "JIANDAOYUN"],
      requiredStreams: { JIANDAOYUN: ["tmall-sku-crosswalk-observation"] },
      requiredIdentities: { JIANDAOYUN: ["sku"] },
    };
    const withIdentityExceptions = sources.map((source) => {
      if (source.key === "SCM") {
        const snapshot = {
          rows: 10,
          asOf: null,
          freshnessMaxAgeDays: null,
          businessAgeDays: null,
          freshness: "current" as const,
        };
        return { ...source, sourceRows: 20, scmEvidence: { "sku-master": snapshot, "sku-identifiers": snapshot } };
      }
      const streams = (product.requiredStreams[source.key] ?? []).map(currentStream);
      return {
        ...source,
        state: "observation" as const,
        configured: true,
        enabled: true,
        configurationReady: true,
        contractSelectionState: "selected" as const,
        selectedContractCount: streams.length,
        selectedStreamKeys: streams.map((item) => item.stream),
        successfulStreams: streams.length,
        successfulStreamKeys: streams.map((item) => item.stream),
        streams,
        sourceRows: 10,
        stagedRows: 10,
        openIdentityExceptions: source.key === "JIANDAOYUN" ? 12 : 0,
        observedIdentities: 20,
        identityCoverage: (product.requiredIdentities[source.key] ?? []).map((domain) => ({
          domain,
          label: CROSS_SYSTEM_IDENTITY_LABEL[domain],
          governance: "scoped_alias" as const,
          state: source.key === "JIANDAOYUN" && domain === "sku" ? "partial" as const : "ready" as const,
          observed: 20,
          governed: source.key === "JIANDAOYUN" && domain === "sku" ? 8 : 20,
          open: source.key === "JIANDAOYUN" && domain === "sku" ? 12 : 0,
          ignored: 0,
          coveragePct: source.key === "JIANDAOYUN" && domain === "sku" ? 40 : 100,
          reason: "测试身份门禁",
          nextAction: "人工认领",
        })),
      };
    });
    const [item] = buildDataProductWorkQueue([product], withIdentityExceptions, []);
    expect(item).toMatchObject({
      stage: "repair",
      actionLabel: "处理身份异常",
      actionHref: "/import/exceptions?status=open&scope=JIANDAOYUN",
    });
  });

  it("keeps a source-wide ready identity blocked when a required stream never extracts it", () => {
    const product = DATA_PRODUCTS.find((item) => item.id === "commerce-identity-control")!;
    const readySources = sources.map((source) => {
      if (source.key === "SCM") {
        const snapshot = {
          rows: 10,
          asOf: null,
          freshnessMaxAgeDays: null,
          businessAgeDays: null,
          freshness: "current" as const,
        };
        return { ...source, sourceRows: 20, scmEvidence: { "sku-master": snapshot, "sku-identifiers": snapshot } };
      }
      const streams = (product.requiredStreams[source.key] ?? []).map(currentStream);
      return {
        ...source,
        state: "observation" as const,
        configured: true,
        enabled: true,
        configurationReady: true,
        contractSelectionState: "selected" as const,
        selectedContractCount: streams.length,
        selectedStreamKeys: streams.map((item) => item.stream),
        successfulStreams: streams.length,
        successfulStreamKeys: streams.map((item) => item.stream),
        streams,
        sourceRows: 10,
        stagedRows: 10,
        openIdentityExceptions: 0,
        observedIdentities: 20,
        identityCoverage: (product.requiredIdentities[source.key] ?? []).map((domain) => ({
          domain,
          label: CROSS_SYSTEM_IDENTITY_LABEL[domain],
          governance: "scoped_alias" as const,
          state: "ready" as const,
          observed: 20,
          governed: 20,
          open: 0,
          ignored: 0,
          coveragePct: 100,
          reason: "测试来源总体覆盖已完成",
          nextAction: "持续监测",
        })),
      };
    });

    const [item] = buildDataProductWorkQueue([product], readySources, []);
    expect(item).toMatchObject({
      stage: "repair",
      blockerState: "identity",
      actionLabel: "查看逐流证据",
      nextAction: expect.stringContaining("拼多多店铺身份"),
    });
    expect(item.bottleneck).toContain("店铺字段尚未进入受控店铺");
  });

  it("routes a source-ready downstream product to its first unsatisfied upstream gate", () => {
    const base = DATA_PRODUCTS[0];
    const downstream = {
      ...base,
      id: "test-downstream",
      title: "下游组合决策",
      sources: [],
      requiredStreams: {},
      requiredIdentities: {},
      requiredScmEvidence: [],
      requiredProducts: [{
        productId: "demand-pulse",
        minimumLevel: "A2" as const,
        purpose: "复用净需求基线",
      }],
    };
    const [item] = buildDataProductWorkQueue([downstream], sources, [release(downstream.id, {
      runtimeLevel: "A1",
      effectiveLevel: "A1",
      gate: "上游尚未放行",
      dependencyGates: [{
        productId: "demand-pulse",
        title: "需求脉搏",
        minimumLevel: "A2",
        effectiveLevel: "A1",
        activeReleaseCurrent: false,
        satisfied: false,
        purpose: "复用净需求基线",
      }],
    })]);
    expect(item).toMatchObject({
      stage: "repair",
      blockerState: "release",
      nextAction: "先将上游「需求脉搏」验收放行到 A2",
      actionLabel: "打开上游门禁",
      actionHref: expect.stringContaining("product=demand-pulse"),
    });
  });

  it("keeps non-identity source failures on their exact stream evidence", () => {
    const product = DATA_PRODUCTS.find((item) => item.id === "exception-triangulation")!;
    const withUnrelatedIdentityExceptions = sources.map((source) => source.key === "JIANDAOYUN"
      ? { ...source, openIdentityExceptions: 12 }
      : source);
    const [item] = buildDataProductWorkQueue([product], withUnrelatedIdentityExceptions, []);
    expect(item).toMatchObject({
      stage: "repair",
      actionLabel: "查看逐流证据",
      actionHref: expect.stringContaining(`product=${product.id}`),
    });
  });

  it("moves a current approved product into result learning before claiming stable monitoring", () => {
    const product = DATA_PRODUCTS[0];
    const approved = {
      id: 8,
      productId: product.id,
      contractVersion: product.contractVersion,
      targetLevel: "A2" as const,
      sourceEvidenceDigest: "current",
      controlTotalRef: "CT-8",
      uatRef: "UAT-8",
      rollbackPlan: "立即停用建议并恢复人工复核",
      scopeNote: null,
      status: "approved" as const,
      requestedBy: 1,
      requestedByName: "A",
      requestedAt: new Date().toISOString(),
      decidedBy: 2,
      decidedByName: "B",
      decidedAt: new Date().toISOString(),
      decisionNote: "已批准",
      revokedBy: null,
      revokedByName: null,
      revokedAt: null,
      version: 2,
    };
    const queue = buildDataProductWorkQueue([product], sources, [release(product.id, {
      effectiveLevel: "A2",
      activeRelease: approved,
      latestRelease: approved,
      activeReleaseCurrent: true,
      canRevoke: true,
    })], [outcome(product.id)]);
    expect(queue).toEqual([expect.objectContaining({
      stage: "learning",
      effectiveLevel: "A2",
      actionLabel: "复盘真实结果",
      actionHref: expect.stringContaining(`product=${product.id}`),
      nextAction: expect.stringContaining("第一条可核验证据"),
    })]);
  });

  it("keeps pending real-world outcomes in the learning queue", () => {
    const product = DATA_PRODUCTS[0];
    const approved = {
      id: 9,
      productId: product.id,
      contractVersion: product.contractVersion,
      targetLevel: "A2" as const,
      sourceEvidenceDigest: "current",
      controlTotalRef: "CT-9",
      uatRef: "UAT-9",
      rollbackPlan: "立即停用建议并恢复人工复核",
      scopeNote: null,
      status: "approved" as const,
      requestedBy: 1,
      requestedByName: "A",
      requestedAt: new Date().toISOString(),
      decidedBy: 2,
      decidedByName: "B",
      decidedAt: new Date().toISOString(),
      decisionNote: "已批准",
      revokedBy: null,
      revokedByName: null,
      revokedAt: null,
      version: 2,
    };
    const queue = buildDataProductWorkQueue([product], sources, [release(product.id, {
      effectiveLevel: "A2",
      activeRelease: approved,
      latestRelease: approved,
      activeReleaseCurrent: true,
    })], [outcome(product.id, { outcomeCount: 3, evaluatedDecisionCount: 2, pendingCount: 1 })]);
    expect(queue[0]).toMatchObject({
      stage: "learning",
      blockerState: "outcome",
      nextAction: "补齐 1 条待观察事项的真实结果与证据编号",
    });
  });

  it("moves only measured and closed feedback into stable monitoring", () => {
    const product = DATA_PRODUCTS[0];
    const approved = {
      id: 10,
      productId: product.id,
      contractVersion: product.contractVersion,
      targetLevel: "A2" as const,
      sourceEvidenceDigest: "current",
      controlTotalRef: "CT-10",
      uatRef: "UAT-10",
      rollbackPlan: "立即停用建议并恢复人工复核",
      scopeNote: null,
      status: "approved" as const,
      requestedBy: 1,
      requestedByName: "A",
      requestedAt: new Date().toISOString(),
      decidedBy: 2,
      decidedByName: "B",
      decidedAt: new Date().toISOString(),
      decisionNote: "已批准",
      revokedBy: null,
      revokedByName: null,
      revokedAt: null,
      version: 2,
    };
    const queue = buildDataProductWorkQueue([product], sources, [release(product.id, {
      effectiveLevel: "A2",
      activeRelease: approved,
      latestRelease: approved,
      activeReleaseCurrent: true,
    })], [outcome(product.id, {
      outcomeCount: 3,
      evaluatedDecisionCount: 3,
      adoptedCount: 2,
      terminalResultCount: 3,
      adoptionRatePct: "66.7",
      falsePositiveRatePct: "0.0",
    })]);
    expect(queue).toEqual([expect.objectContaining({
      stage: "monitor",
      actionLabel: "进入业务分析",
      actionHref: "/report/decision-studio?tab=identity",
      nextAction: expect.stringContaining("持续复核采纳"),
    })]);
  });
});
