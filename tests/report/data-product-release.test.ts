import { describe, expect, it } from "vitest";

import { DATA_PRODUCTS } from "@/components/data-products";
import { auditLogs, dataProductReleases, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  buildDataProductReleaseEvidence,
  decideDataProductRelease,
  loadDataProductReleaseReadiness,
} from "@/server/modules/report/data-product-release";
import type {
  DataSourceReadiness,
  DataStreamEvidence,
  ScmEvidenceSnapshot,
} from "@/server/modules/report/data-source-readiness";
import { createTestDb } from "../helpers/db";

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

describe("数据产品放行闭环", () => {
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
