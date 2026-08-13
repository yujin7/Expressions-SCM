import { describe, expect, it } from "vitest";

import { DATA_PRODUCTS } from "@/components/data-products";
import { buildDataProductWorkQueue } from "@/components/data-product-work-queue";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import type { DataProductOutcomeReadiness } from "@/server/modules/report/data-product-outcome";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";

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
    expect(queue.find((item) => item.productId === "demand-pulse")?.nextAction).toContain("天猫 SKU 对照");
    expect(queue.find((item) => item.productId === "demand-pulse")?.nextAction).not.toContain("tmall-sku-crosswalk-observation");
    expect(queue.find((item) => item.productId === "demand-pulse")?.actionLabel).toBe("查看逐流证据");
  });

  it("routes an external identity blocker to the scoped human-claim queue", () => {
    const product = DATA_PRODUCTS.find((item) => item.id === "commerce-identity-control")!;
    const withIdentityExceptions = sources.map((source) => source.key === "JIANDAOYUN"
      ? { ...source, openIdentityExceptions: 12 }
      : source);
    const [item] = buildDataProductWorkQueue([product], withIdentityExceptions, []);
    expect(item).toMatchObject({
      stage: "repair",
      actionLabel: "处理身份异常",
      actionHref: "/import/exceptions?status=open&scope=JIANDAOYUN",
    });
  });

  it("routes a source-ready downstream product to its first unsatisfied upstream gate", () => {
    const base = DATA_PRODUCTS[0];
    const downstream = {
      ...base,
      id: "test-downstream",
      title: "下游组合决策",
      sources: [],
      requiredStreams: {},
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
