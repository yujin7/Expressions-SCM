import { describe, expect, it } from "vitest";

import { DATA_PRODUCTS } from "@/components/data-products";
import { buildDataProductWorkQueue } from "@/components/data-product-work-queue";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
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
  });

  it("moves a current approved product to monitoring instead of asking for another release", () => {
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
    })]);
    expect(queue).toEqual([expect.objectContaining({ stage: "monitor", effectiveLevel: "A2" })]);
  });
});
