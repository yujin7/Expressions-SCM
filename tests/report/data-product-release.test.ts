import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { DATA_PRODUCTS } from "@/components/data-products";
import { auditLogs, dataProductReleases, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  buildDataProductReleaseEvidence,
  decideDataProductRelease,
  loadDataProductReleaseReadiness,
  type DataProductReleaseReadiness,
} from "@/server/modules/report/data-product-release";
import type {
  DataSourceReadiness,
  DataStreamEvidence,
  ScmEvidenceSnapshot,
} from "@/server/modules/report/data-source-readiness";
import {
  CROSS_SYSTEM_IDENTITY_LABEL,
  CROSS_SYSTEM_IDENTITY_EXTRACTION_CONTRACT_VERSION,
  CROSS_SYSTEM_IDENTITY_ORDER,
} from "@/lib/cross-system-identity";
import { CROSS_SYSTEM_SEMANTIC_CONTRACT_VERSION } from "@/lib/cross-system-semantics";
import { createTestDb } from "../helpers/db";

/*
 * 本文件验证放行台账本身；把已登记的逐流提取契约提升为“已完成”的受控夹具，
 * 避免真实目录中刻意保持 fail-closed 的外部缺口掩盖会签/失效测试。
 */
vi.mock("@/lib/cross-system-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cross-system-identity")>();
  return {
    ...actual,
    getCrossSystemIdentityStreamContract: (source: "JIANDAOYUN" | "JST" | "YONYOU", stream: string) => {
      const contract = actual.getCrossSystemIdentityStreamContract(source, stream);
      if (!contract) return null;
      return {
        ...contract,
        identities: Object.fromEntries(Object.entries(contract.identities).map(([domain, control]) => [
          domain,
          {
            ...control,
            state: "implemented",
            evidence: "测试夹具：逐流身份已进入受控治理",
            nextAction: "持续监测",
          },
        ])),
      };
    },
  };
});

vi.mock("@/lib/cross-system-semantics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cross-system-semantics")>();
  return {
    ...actual,
    getCrossSystemSemanticStreamContract: (source: "JIANDAOYUN" | "JST" | "YONYOU", stream: string) => {
      const contract = actual.getCrossSystemSemanticStreamContract(source, stream);
      if (!contract) return null;
      return {
        ...contract,
        controls: Object.fromEntries(Object.entries(contract.controls).map(([domain, control]) => [
          domain,
          {
            ...control,
            state: "implemented",
            evidence: "测试夹具：业务语义已固化",
            nextAction: "持续监测",
          },
        ])),
      };
    },
  };
});

const product = DATA_PRODUCTS.find((item) => item.id === "commerce-identity-control")!;

function stream(key: string, overrides: Partial<DataStreamEvidence> = {}): DataStreamEvidence {
  return {
    stream: key,
    latestStatus: "succeeded",
    latestRunAt: "2026-08-12T01:00:00.000Z",
    lastSuccessAt: "2026-08-12T01:00:00.000Z",
    sourceAsOf: "2026-08-11",
    sourceRows: 10,
    stagedRows: 10,
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
  streams: DataStreamEvidence[],
  options: { binding?: string; scmEvidence?: DataSourceReadiness["scmEvidence"] } = {},
): DataSourceReadiness {
  const identityCoverage = key === "SCM" ? [] : CROSS_SYSTEM_IDENTITY_ORDER.map((domain) => ({
    domain,
    label: CROSS_SYSTEM_IDENTITY_LABEL[domain],
    governance: domain === "document" ? "external_reference" as const : "scoped_alias" as const,
    state: "ready" as const,
    observed: 10,
    governed: 10,
    open: 0,
    ignored: 0,
    coveragePct: 100,
    reason: "测试夹具已精确认领",
    nextAction: "持续监测",
  }));
  return {
    key,
    label: key,
    state: key === "SCM" ? "operational" : "observation",
    configured: true,
    enabled: true,
    configurationReady: true,
    configurationBinding: options.binding ?? `binding:${key}:v1`,
    contractSelectionState: key === "SCM" ? "not_required" : "selected",
    selectedContractCount: key === "SCM" ? 0 : streams.length,
    successfulStreams: streams.length,
    successfulStreamKeys: streams.map((item) => item.stream),
    streams,
    latestFailedStreams: 0,
    latestRunningStreams: 0,
    sourceRows: streams.reduce((sum, item) => sum + item.sourceRows, 0),
    stagedRows: streams.reduce((sum, item) => sum + item.stagedRows, 0),
    rejectedRows: streams.reduce((sum, item) => sum + item.rejectedRows, 0),
    latestRunAt: streams[0]?.latestRunAt ?? null,
    lastSuccessAt: streams[0]?.lastSuccessAt ?? null,
    sourceAsOfStart: streams[0]?.sourceAsOf ?? null,
    sourceAsOfEnd: streams.at(-1)?.sourceAsOf ?? null,
    openIdentityExceptions: 0,
    observedIdentities: 10,
    identityCoverage,
    scmEvidence: options.scmEvidence ?? {},
    gate: "test gate",
    nextAction: "test next",
  };
}

function currentSources(): DataSourceReadiness[] {
  const scm: ScmEvidenceSnapshot = {
    rows: 10,
    asOf: null,
    freshnessMaxAgeDays: null,
    businessAgeDays: null,
    freshness: "current",
  };
  return [
    source("SCM", [], { scmEvidence: { "sku-master": scm, "sku-identifiers": scm } }),
    source("JIANDAOYUN", [
      stream("tmall-sku-crosswalk-observation"),
      stream("pdd-sku-crosswalk-observation"),
      stream("vip-product-crosswalk-observation"),
    ]),
    source("JST", [stream("item-master")]),
  ];
}

function currentSourcesForProducts(productIds: string[]): DataSourceReadiness[] {
  const products = DATA_PRODUCTS.filter((item) => productIds.includes(item.id));
  const scm: ScmEvidenceSnapshot = {
    rows: 10,
    asOf: null,
    freshnessMaxAgeDays: null,
    businessAgeDays: null,
    freshness: "current",
  };
  const scmEvidence = Object.fromEntries(
    [...new Set(products.flatMap((item) => item.requiredScmEvidence))].map((key) => [key, scm]),
  ) as DataSourceReadiness["scmEvidence"];
  return (["SCM", "JIANDAOYUN", "JST", "YONYOU"] as const).map((key) => {
    const streams = [...new Set(products.flatMap((item) => item.requiredStreams[key] ?? []))].map((key) => stream(key));
    return source(key, streams, { scmEvidence: key === "SCM" ? scmEvidence : {} });
  });
}

describe("数据产品放行闭环", () => {
  it("下游组合产品必须绑定当前有效的上游产品放行，且上游换版会改变范围指纹", () => {
    const composed = {
      ...product,
      id: "test-composed-product",
      contractVersion: "1.1.0",
      requiredProducts: [{
        productId: product.id,
        minimumLevel: "A2" as const,
        purpose: "复用已验收的平台身份口径",
      }],
    };
    const withoutUpstream = buildDataProductReleaseEvidence(composed, currentSources());
    expect(withoutUpstream.eligible).toBe(false);
    expect(withoutUpstream.gate).toContain("平台身份控制塔需A2（当前A0）");

    const activeRelease = {
      id: 91,
      productId: product.id,
      contractVersion: product.contractVersion,
      targetLevel: "A2" as const,
      sourceEvidenceDigest: "upstream-scope-v1",
      controlTotalRef: "CT-UPSTREAM",
      uatRef: "UAT-UPSTREAM",
      rollbackPlan: "立即退回人工身份复核并停止输出建议",
      scopeNote: null,
      status: "approved" as const,
      requestedBy: 1,
      requestedByName: "A",
      requestedAt: "2026-08-14T01:00:00.000Z",
      decidedBy: 2,
      decidedByName: "B",
      decidedAt: "2026-08-14T02:00:00.000Z",
      decisionNote: "通过",
      revokedBy: null,
      revokedByName: null,
      revokedAt: null,
      version: 2,
    };
    const upstream: DataProductReleaseReadiness = {
      productId: product.id,
      runtimeLevel: "A1",
      effectiveLevel: "A2",
      eligibleForRequest: true,
      gate: "有效",
      currentScopeDigest: "upstream-scope-v1",
      activeRelease,
      pendingRelease: null,
      latestRelease: activeRelease,
      activeReleaseCurrent: true,
      canRequest: false,
      canApprove: false,
      canReject: false,
      canRevoke: true,
      dependencyGates: [],
    };
    const withUpstream = buildDataProductReleaseEvidence(composed, currentSources(), new Date(), [upstream]);
    expect(withUpstream.eligible).toBe(true);
    expect(withUpstream.envelope.dependencyBindings).toEqual([expect.objectContaining({
      productId: product.id,
      activeReleaseId: 91,
      sourceEvidenceDigest: "upstream-scope-v1",
    })]);

    const changed = buildDataProductReleaseEvidence(composed, currentSources(), new Date(), [{
      ...upstream,
      activeRelease: { ...activeRelease, id: 92, sourceEvidenceDigest: "upstream-scope-v2" },
      latestRelease: { ...activeRelease, id: 92, sourceEvidenceDigest: "upstream-scope-v2" },
      currentScopeDigest: "upstream-scope-v2",
    }]);
    expect(changed.scopeDigest).not.toBe(withUpstream.scopeDigest);
  });

  it("上游放行失效会通过真实读取模型级联关闭补货产品资格", async () => {
    const { db } = await createTestDb();
    const [owner] = await db.insert(users).values({ name: "PMC", roles: ["pmc"], isApprover: true }).returning();
    const productIds = [
      "commerce-identity-control",
      "demand-pulse",
      "unified-inventory",
      "supply-commitment",
      "replenishment-evidence",
    ];
    const sources = currentSourcesForProducts(productIds);
    const upstreamProducts = DATA_PRODUCTS.filter((item) => productIds.slice(0, 4).includes(item.id));
    const createdIds: number[] = [];
    for (const [index, upstream] of upstreamProducts.entries()) {
      const currentReadiness = await loadDataProductReleaseReadiness(sources, undefined, db);
      const evidence = buildDataProductReleaseEvidence(upstream, sources, new Date(), currentReadiness);
      expect(evidence.eligible).toBe(true);
      const [created] = await db.insert(dataProductReleases).values({
        productId: upstream.id,
        contractVersion: upstream.contractVersion,
        targetLevel: "A2",
        sourceEvidenceDigest: evidence.scopeDigest,
        sourceEvidence: evidence.envelope,
        controlTotalRef: `CT-UP-${index}`,
        uatRef: `UAT-UP-${index}`,
        rollbackPlan: "立即关闭上游建议并恢复人工复核",
        status: "approved",
        idempotencyKey: `00000000-0000-4000-8000-00000000010${index}`,
        requestedBy: owner.id,
        decidedBy: owner.id,
        decidedAt: new Date(),
        decisionNote: "测试放行",
      }).returning();
      createdIds.push(created.id);
    }

    const ready = (await loadDataProductReleaseReadiness(sources, undefined, db))
      .find((item) => item.productId === "replenishment-evidence")!;
    expect(ready.eligibleForRequest).toBe(true);
    expect(ready.dependencyGates.every((item) => item.satisfied)).toBe(true);

    await db.update(dataProductReleases)
      .set({ status: "revoked", revokedBy: owner.id, revokedAt: new Date(), decisionNote: "测试撤回" })
      .where(eq(dataProductReleases.id, createdIds[0]));
    const degraded = (await loadDataProductReleaseReadiness(sources, undefined, db))
      .find((item) => item.productId === "replenishment-evidence")!;
    expect(degraded.eligibleForRequest).toBe(false);
    expect(degraded.gate).toContain("需求脉搏需A2（当前A1）");
    expect(degraded.dependencyGates.find((item) => item.productId === "demand-pulse")?.satisfied).toBe(false);
  });

  it("没有待会签申请时，审批人也不得看到批准或拒绝动作", async () => {
    const { db } = await createTestDb();
    const [person] = await db.insert(users).values({
      name: "PMC审批人",
      roles: ["pmc"],
      isApprover: true,
    }).returning();
    const approver: SessionUser = {
      id: person.id,
      name: person.name,
      roles: ["pmc"],
      isApprover: true,
    };
    const readiness = (await loadDataProductReleaseReadiness(currentSources(), approver, db))
      .find((item) => item.productId === product.id)!;

    expect(readiness).toMatchObject({
      pendingRelease: null,
      activeRelease: null,
      canApprove: false,
      canReject: false,
      canRevoke: false,
    });
  });

  it("正常日常刷新不使批准失效，但连接配置范围变化会改变指纹", () => {
    const firstSources = currentSources();
    const first = buildDataProductReleaseEvidence(product, firstSources, new Date("2026-08-12T02:00:00Z"));
    expect(first.envelope.schemaVersion).toBe("data-product-release/v5");
    expect(first.envelope.product.identityExtractionContractVersion)
      .toBe(CROSS_SYSTEM_IDENTITY_EXTRACTION_CONTRACT_VERSION);
    expect(first.envelope.product.identityExtractionScope).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "JIANDAOYUN",
        stream: "pdd-sku-crosswalk-observation",
        identities: expect.arrayContaining([
          expect.objectContaining({ domain: "sku", state: "not_implemented" }),
        ]),
      }),
    ]));
    expect(first.envelope.product.semanticContractVersion).toBe(CROSS_SYSTEM_SEMANTIC_CONTRACT_VERSION);
    expect(first.envelope.product.semanticScope).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "JIANDAOYUN",
        stream: "pdd-sku-crosswalk-observation",
        domain: "identifier_namespace",
        state: "business_review_pending",
      }),
    ]));
    const refreshedSources = currentSources();
    refreshedSources[1].streams[0] = stream("tmall-sku-crosswalk-observation", {
      latestRunAt: "2026-08-13T01:00:00.000Z",
      lastSuccessAt: "2026-08-13T01:00:00.000Z",
      sourceAsOf: "2026-08-12",
      sourceRows: 20,
      stagedRows: 20,
    });
    const refreshed = buildDataProductReleaseEvidence(product, refreshedSources, new Date("2026-08-13T02:00:00Z"));
    expect(first.eligible).toBe(true);
    expect(refreshed.scopeDigest).toBe(first.scopeDigest);

    refreshedSources[1].configurationBinding = "binding:JIANDAOYUN:v2";
    expect(buildDataProductReleaseEvidence(product, refreshedSources).scopeDigest).not.toBe(first.scopeDigest);
  });

  it("拒绝自批并以另一名责任审批人完成会签，审计与状态同事务", async () => {
    const { db } = await createTestDb();
    const people = await db.insert(users).values([
      { name: "运营发起人", roles: ["ops"], isApprover: true },
      { name: "PMC审批人", roles: ["pmc"], isApprover: true },
    ]).returning();
    const requester: SessionUser = { id: people[0].id, name: people[0].name, roles: ["ops"], isApprover: true };
    const approver: SessionUser = { id: people[1].id, name: people[1].name, roles: ["pmc"], isApprover: true };
    const evidence = buildDataProductReleaseEvidence(product, currentSources());
    const [pending] = await db.insert(dataProductReleases).values({
      productId: product.id,
      contractVersion: product.contractVersion,
      targetLevel: "A2",
      sourceEvidenceDigest: evidence.scopeDigest,
      sourceEvidence: evidence.envelope,
      controlTotalRef: "CT-001",
      uatRef: "UAT-001",
      rollbackPlan: "关闭建议入口并退回仅观察状态",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      requestedBy: requester.id,
    }).returning();

    await expect(db.insert(dataProductReleases).values({
      productId: product.id,
      contractVersion: product.contractVersion,
      targetLevel: "A2",
      sourceEvidenceDigest: evidence.scopeDigest,
      sourceEvidence: evidence.envelope,
      controlTotalRef: "CT-CONCURRENT",
      uatRef: "UAT-CONCURRENT",
      rollbackPlan: "并发申请必须被数据库唯一闸拒绝",
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      requestedBy: approver.id,
    })).rejects.toThrow();

    await expect(decideDataProductRelease(requester, {
      id: pending.id,
      action: "reject",
      note: "不能自己审批",
      expectedVersion: 1,
    }, db)).rejects.toMatchObject({ status: 403 });

    const changed = currentSources();
    changed[2].configurationBinding = "binding:JST:v2";
    const stalePending = (await loadDataProductReleaseReadiness(changed, approver, db))
      .find((item) => item.productId === product.id)!;
    expect(stalePending).toMatchObject({
      canApprove: false,
      canReject: true,
      effectiveLevel: "A1",
    });
    expect(stalePending.gate).toContain("禁止批准");

    const rejected = await decideDataProductRelease(approver, {
      id: pending.id,
      action: "reject",
      note: "控制总量尚未签认",
      expectedVersion: 1,
    }, db);
    expect(rejected).toMatchObject({ status: "rejected", version: 2, decidedBy: approver.id });
    const audits = await db.select().from(auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity: "data_product_release", entityId: pending.id, action: "reject" });
  });

  it("批准只在当前范围和实时证据仍成立时生效，责任人可立即撤回", async () => {
    const { db } = await createTestDb();
    const people = await db.insert(users).values([
      { name: "运营发起人", roles: ["ops"] },
      { name: "PMC责任人", roles: ["pmc"], isApprover: true },
    ]).returning();
    const operator: SessionUser = { id: people[1].id, name: people[1].name, roles: ["pmc"], isApprover: true };
    const sources = currentSources();
    const evidence = buildDataProductReleaseEvidence(product, sources);
    const [approved] = await db.insert(dataProductReleases).values({
      productId: product.id,
      contractVersion: product.contractVersion,
      targetLevel: "A2",
      sourceEvidenceDigest: evidence.scopeDigest,
      sourceEvidence: evidence.envelope,
      controlTotalRef: "CT-002",
      uatRef: "UAT-002",
      rollbackPlan: "停止身份修复建议并保留原证据",
      status: "approved",
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
      requestedBy: people[0].id,
      decidedBy: people[1].id,
      decidedAt: new Date(),
      decisionNote: "同意限定范围放行",
    }).returning();

    const current = (await loadDataProductReleaseReadiness(sources, operator, db)).find((item) => item.productId === product.id)!;
    expect(current).toMatchObject({ effectiveLevel: "A2", activeReleaseCurrent: true, canRevoke: true });

    const changed = currentSources();
    changed[2].configurationBinding = "binding:JST:v2";
    const invalidated = (await loadDataProductReleaseReadiness(changed, operator, db)).find((item) => item.productId === product.id)!;
    expect(invalidated).toMatchObject({ effectiveLevel: "A1", activeReleaseCurrent: false });

    const blocked = currentSources();
    blocked[1].state = "contract_only";
    blocked[1].configurationReady = true;
    const blockedByCurrentConnectorState = (await loadDataProductReleaseReadiness(blocked, operator, db))
      .find((item) => item.productId === product.id)!;
    expect(blockedByCurrentConnectorState).toMatchObject({
      runtimeLevel: "A0",
      effectiveLevel: "A0",
      activeReleaseCurrent: false,
    });
    expect(blockedByCurrentConnectorState.gate).toContain("自动降回 A0/A1");

    const revoked = await decideDataProductRelease(operator, {
      id: approved.id,
      action: "revoke",
      note: "连接范围变化，立即停用",
      expectedVersion: 1,
    }, db);
    expect(revoked).toMatchObject({ status: "revoked", version: 2, revokedBy: operator.id });
  });
});
