import { describe, expect, it } from "vitest";

import { DATA_PRODUCTS } from "@/components/data-products";
import { auditLogs, dataProductOutcomeEvents, dataProductReleases, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  loadDataProductOutcomeReadiness,
  recordDataProductOutcome,
} from "@/server/modules/report/data-product-outcome";
import {
  buildDataProductReleaseEvidence,
  loadDataProductReleaseReadiness,
} from "@/server/modules/report/data-product-release";
import { todayShanghai } from "@/server/modules/master/common";
import type {
  DataSourceReadiness,
  DataStreamEvidence,
  ScmEvidenceSnapshot,
} from "@/server/modules/report/data-source-readiness";
import { createTestDb } from "../helpers/db";
import { CROSS_SYSTEM_IDENTITY_LABEL, CROSS_SYSTEM_IDENTITY_ORDER } from "@/lib/cross-system-identity";

const product = DATA_PRODUCTS.find((item) => item.id === "commerce-identity-control")!;

function stream(key: string): DataStreamEvidence {
  return {
    stream: key,
    latestStatus: "succeeded",
    latestRunAt: "2026-08-13T01:00:00.000Z",
    lastSuccessAt: "2026-08-13T01:00:00.000Z",
    sourceAsOf: "2026-08-12",
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
    pipelineAgeHours: 2,
    freshness: "current",
  };
}

function source(
  key: DataSourceReadiness["key"],
  streams: DataStreamEvidence[],
  scmEvidence: DataSourceReadiness["scmEvidence"] = {},
): DataSourceReadiness {
  return {
    key,
    label: key,
    state: key === "SCM" ? "operational" : "observation",
    configured: true,
    enabled: true,
    configurationReady: true,
    configurationBinding: `binding:${key}:v1`,
    contractSelectionState: key === "SCM" ? "not_required" : "selected",
    selectedContractCount: key === "SCM" ? 0 : streams.length,
    successfulStreams: streams.length,
    successfulStreamKeys: streams.map((item) => item.stream),
    streams,
    latestFailedStreams: 0,
    latestRunningStreams: 0,
    sourceRows: streams.reduce((sum, item) => sum + item.sourceRows, 0),
    stagedRows: streams.reduce((sum, item) => sum + item.stagedRows, 0),
    rejectedRows: 0,
    latestRunAt: streams[0]?.latestRunAt ?? null,
    lastSuccessAt: streams[0]?.lastSuccessAt ?? null,
    sourceAsOfStart: streams[0]?.sourceAsOf ?? null,
    sourceAsOfEnd: streams.at(-1)?.sourceAsOf ?? null,
    openIdentityExceptions: 0,
    observedIdentities: 10,
    identityCoverage: key === "SCM" ? [] : CROSS_SYSTEM_IDENTITY_ORDER.map((domain) => ({
      domain,
      label: CROSS_SYSTEM_IDENTITY_LABEL[domain],
      governance: domain === "document" ? "external_reference" as const : "scoped_alias" as const,
      state: "ready" as const,
      observed: 10,
      governed: 10,
      open: 0,
      ignored: 0,
      coveragePct: 100,
      reason: "测试夹具已统一",
      nextAction: "持续监测",
    })),
    scmEvidence,
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
    source("SCM", [], { "sku-master": scm, "sku-identifiers": scm }),
    source("JIANDAOYUN", [
      stream("tmall-sku-crosswalk-observation"),
      stream("pdd-sku-crosswalk-observation"),
      stream("vip-product-crosswalk-observation"),
    ]),
    source("JST", [stream("item-master")]),
  ];
}

async function seedApprovedRelease(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  requesterId: number,
  approverId: number,
) {
  const evidence = buildDataProductReleaseEvidence(product, currentSources());
  const [release] = await db.insert(dataProductReleases).values({
    productId: product.id,
    contractVersion: product.contractVersion,
    targetLevel: "A2",
    sourceEvidenceDigest: evidence.scopeDigest,
    sourceEvidence: evidence.envelope,
    controlTotalRef: "CT-OUTCOME-001",
    uatRef: "UAT-OUTCOME-001",
    rollbackPlan: "停止结果登记入口并回退到观察层",
    status: "approved",
    idempotencyKey: globalThis.crypto.randomUUID(),
    requestedBy: requesterId,
    decidedBy: approverId,
    decidedAt: new Date(),
    decisionNote: "同意受控反馈闭环",
  }).returning();
  return release;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    productId: product.id,
    decisionRef: "IDENTITY-20260813-001",
    businessDate: todayShanghai(),
    decision: "accepted",
    result: "positive",
    handlingMinutes: 30,
    savedHours: "1.25",
    evidenceRef: "UAT-RESULT-001",
    note: "身份建议已核验并采纳",
    idempotencyKey: globalThis.crypto.randomUUID(),
    ...overrides,
  };
}

function shiftBusinessDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

describe("数据产品真实结果闭环", () => {
  it("没有当前有效 A2/A3 放行时拒绝把观察信号登记为正式结果", async () => {
    const { db } = await createTestDb();
    const [person] = await db.insert(users).values({ name: "运营", roles: ["ops"] }).returning();
    const operator: SessionUser = { id: person.id, name: person.name, roles: ["ops"], isApprover: false };

    await expect(recordDataProductOutcome(operator, input(), db, currentSources()))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(dataProductOutcomeEvents)).toHaveLength(0);
  });

  it("根结果不能倒填到放行前，也不能登记未来日期", async () => {
    const { db } = await createTestDb();
    const people = await db.insert(users).values([
      { name: "运营", roles: ["ops"] },
      { name: "PMC", roles: ["pmc"], isApprover: true },
    ]).returning();
    const operator: SessionUser = { id: people[0].id, name: people[0].name, roles: ["ops"], isApprover: false };
    await seedApprovedRelease(db, people[0].id, people[1].id);
    const today = todayShanghai();

    await expect(recordDataProductOutcome(
      operator,
      input({ businessDate: shiftBusinessDate(today, -1) }),
      db,
      currentSources(),
    )).rejects.toMatchObject({ status: 409 });
    await expect(recordDataProductOutcome(
      operator,
      input({ businessDate: shiftBusinessDate(today, 1) }),
      db,
      currentSources(),
    )).rejects.toThrow("真实结果不能登记未来业务日期");
    expect(await db.select().from(dataProductOutcomeEvents)).toHaveLength(0);
  });

  it("责任人登记与审计同事务，幂等重放稳定且数据库禁止改写", async () => {
    const { db } = await createTestDb();
    const people = await db.insert(users).values([
      { name: "运营", roles: ["ops"] },
      { name: "PMC", roles: ["pmc"], isApprover: true },
    ]).returning();
    const operator: SessionUser = { id: people[0].id, name: people[0].name, roles: ["ops"], isApprover: false };
    await seedApprovedRelease(db, people[0].id, people[1].id);
    const payload = input();

    const created = await recordDataProductOutcome(operator, payload, db, currentSources());
    const replay = await recordDataProductOutcome(operator, payload, db, currentSources());
    expect(replay.id).toBe(created.id);
    await expect(recordDataProductOutcome(operator, { ...payload, note: "同键不同事实" }, db, currentSources()))
      .rejects.toMatchObject({ status: 409 });
    await expect(db.update(dataProductOutcomeEvents).set({ note: "禁止覆盖" }))
      .rejects.toThrow();

    const rows = await db.select().from(dataProductOutcomeEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("身份建议已核验并采纳");
    const audits = await db.select().from(auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity: "data_product_outcome", action: "record", entityId: created.id });
  });

  it("纠正形成单链，汇总只计算叶子版本且未知指标保持空值", async () => {
    const { db } = await createTestDb();
    const people = await db.insert(users).values([
      { name: "运营", roles: ["ops"] },
      { name: "PMC", roles: ["pmc"], isApprover: true },
    ]).returning();
    const operator: SessionUser = { id: people[0].id, name: people[0].name, roles: ["ops"], isApprover: false };
    await seedApprovedRelease(db, people[0].id, people[1].id);
    const first = await recordDataProductOutcome(operator, input({
      result: "pending",
      evidenceRef: null,
      handlingMinutes: null,
      savedHours: null,
    }), db, currentSources());
    const correctedPayload = input({
      idempotencyKey: globalThis.crypto.randomUUID(),
      supersedesId: first.id,
      decision: "rejected",
      result: "false_positive",
      reasonCode: "low_confidence",
      evidenceRef: "REVIEW-002",
      handlingMinutes: 45,
      savedHours: "0.50",
      note: "复核后确认属于误报",
    });
    const corrected = await recordDataProductOutcome(operator, correctedPayload, db);
    await expect(recordDataProductOutcome(operator, {
      ...correctedPayload,
      idempotencyKey: globalThis.crypto.randomUUID(),
    }, db)).rejects.toMatchObject({ status: 409 });

    const releases = await loadDataProductReleaseReadiness(currentSources(), operator, db);
    const summary = (await loadDataProductOutcomeReadiness(releases, operator, db))
      .find((item) => item.productId === product.id)!;
    expect(summary).toMatchObject({
      outcomeCount: 1,
      evaluatedDecisionCount: 1,
      adoptedCount: 0,
      terminalResultCount: 1,
      falsePositiveCount: 1,
      adoptionRatePct: "0.0",
      falsePositiveRatePct: "100.0",
      avgHandlingMinutes: "45.0",
      savedHoursTotal: "0.50",
    });
    expect(summary.latest[0].id).toBe(corrected.id);
    expect(await db.select().from(dataProductOutcomeEvents)).toHaveLength(2);
  });

  it("现金影响按角色限制写入与读取，未授权角色只看到空值而不是零", async () => {
    const { db } = await createTestDb();
    const people = await db.insert(users).values([
      { name: "运营", roles: ["ops"] },
      { name: "PMC", roles: ["pmc"], isApprover: true },
    ]).returning();
    const ops: SessionUser = { id: people[0].id, name: people[0].name, roles: ["ops"], isApprover: false };
    const pmc: SessionUser = { id: people[1].id, name: people[1].name, roles: ["pmc"], isApprover: true };
    await seedApprovedRelease(db, people[0].id, people[1].id);

    await expect(recordDataProductOutcome(ops, input({ cashImpact: "123.45" }), db, currentSources()))
      .rejects.toMatchObject({ status: 403 });
    const cashRow = await recordDataProductOutcome(pmc, input({ cashImpact: "123.45" }), db, currentSources());
    await recordDataProductOutcome(ops, input({
      supersedesId: cashRow.id,
      idempotencyKey: globalThis.crypto.randomUUID(),
      note: "运营纠正说明但不能看见或清除现金影响",
    }), db);
    const releases = await loadDataProductReleaseReadiness(currentSources(), pmc, db);
    const pmcSummary = (await loadDataProductOutcomeReadiness(releases, pmc, db))
      .find((item) => item.productId === product.id)!;
    const opsSummary = (await loadDataProductOutcomeReadiness(releases, ops, db))
      .find((item) => item.productId === product.id)!;
    expect(pmcSummary.cashImpactTotal).toBe("123.45");
    expect(pmcSummary.latest[0].cashImpact).toBe("123.45");
    expect(opsSummary.cashImpactTotal).toBeNull();
    expect(opsSummary.latest[0]).toMatchObject({ cashImpact: null, currency: null, cashVisible: false });
  });
});
