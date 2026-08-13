import { describe, expect, it, vi } from "vitest";

import { DATA_PRODUCTS } from "@/components/data-products";
import { dataProductReleases, systemAlerts, users } from "@/db/schema";
import { runDataProductGateWatchdog } from "@/jobs/data-product-gate-watchdog";
import { buildDataProductReleaseEvidence } from "@/server/modules/report/data-product-release";
import type {
  DataSourceReadiness,
  DataStreamEvidence,
  ScmEvidenceSnapshot,
} from "@/server/modules/report/data-source-readiness";
import { createTestDb, type TestDb } from "../helpers/db";
import { CROSS_SYSTEM_IDENTITY_LABEL, CROSS_SYSTEM_IDENTITY_ORDER } from "@/lib/cross-system-identity";

vi.mock("@/lib/cross-system-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cross-system-identity")>();
  return {
    ...actual,
    getCrossSystemIdentityStreamContract: (source: "JIANDAOYUN" | "JST" | "YONYOU", stream: string) => {
      const contract = actual.getCrossSystemIdentityStreamContract(source, stream);
      return contract ? {
        ...contract,
        identities: Object.fromEntries(Object.entries(contract.identities).map(([domain, control]) => [
          domain,
          { ...control, state: "implemented", evidence: "看门狗测试夹具已治理", nextAction: "持续监测" },
        ])),
      } : null;
    },
  };
});

vi.mock("@/lib/cross-system-semantics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cross-system-semantics")>();
  return {
    ...actual,
    getCrossSystemSemanticStreamContract: (source: "JIANDAOYUN" | "JST" | "YONYOU", stream: string) => {
      const contract = actual.getCrossSystemSemanticStreamContract(source, stream);
      return contract ? {
        ...contract,
        controls: Object.fromEntries(Object.entries(contract.controls).map(([domain, control]) => [
          domain,
          { ...control, state: "implemented", evidence: "看门狗测试夹具已固化", nextAction: "持续监测" },
        ])),
      } : null;
    },
  };
});

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
    pipelineAgeHours: 3,
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
  const snapshot: ScmEvidenceSnapshot = {
    rows: 10,
    asOf: null,
    freshnessMaxAgeDays: null,
    businessAgeDays: null,
    freshness: "current",
  };
  return [
    source("SCM", [], { "sku-master": snapshot, "sku-identifiers": snapshot }),
    source("JIANDAOYUN", [
      stream("tmall-sku-crosswalk-observation"),
      stream("pdd-sku-crosswalk-observation"),
      stream("vip-product-crosswalk-observation"),
    ]),
    source("JST", [stream("item-master")]),
  ];
}

async function seedApprovedRelease(db: TestDb): Promise<number> {
  const people = await db.insert(users).values([
    { name: "运营发起人", roles: ["ops"] },
    { name: "PMC审批人", roles: ["pmc"], isApprover: true },
  ]).returning();
  const evidence = buildDataProductReleaseEvidence(product, currentSources());
  const [release] = await db.insert(dataProductReleases).values({
    productId: product.id,
    contractVersion: product.contractVersion,
    targetLevel: "A2",
    sourceEvidenceDigest: evidence.scopeDigest,
    sourceEvidence: evidence.envelope,
    controlTotalRef: "CT-GATE-001",
    uatRef: "UAT-GATE-001",
    rollbackPlan: "停用身份修复建议并返回观察模式",
    status: "approved",
    idempotencyKey: "00000000-0000-4000-8000-000000000041",
    requestedBy: people[0].id,
    decidedBy: people[1].id,
    decidedAt: new Date("2026-08-13T02:00:00Z"),
    decisionNote: "限定当前范围批准",
  }).returning();
  return release.id;
}

describe("数据产品放行门禁看门狗", () => {
  it("当前 A2 仍有效时不制造告警", async () => {
    const { db } = await createTestDb();
    await seedApprovedRelease(db);
    expect(await runDataProductGateWatchdog(db, { dataSources: currentSources() }))
      .toMatchObject({ opened: 0, autoClosed: 0, invalidatedProducts: [] });
    expect(await db.select().from(systemAlerts)).toHaveLength(0);
  });

  it("连接器退回仅契约时开一次责任告警，重复运行不刷屏", async () => {
    const { db } = await createTestDb();
    const releaseId = await seedApprovedRelease(db);
    const blocked = currentSources();
    blocked[1].state = "contract_only";

    const first = await runDataProductGateWatchdog(db, { dataSources: blocked });
    const second = await runDataProductGateWatchdog(db, { dataSources: blocked });
    expect(first).toMatchObject({ opened: 1, invalidatedProducts: [product.id] });
    expect(second.opened).toBe(0);

    const alerts = await db.select().from(systemAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      category: "data_product_gate",
      refKey: `${product.id}:${releaseId}`,
      severity: "medium",
      status: "open",
    });
    expect(alerts[0].title).toContain("从 A2 自动降级");
    expect(alerts[0].detail).toContain("责任人");
  });

  it("来源恢复后自动关闭，再次失效会生成新的告警证据", async () => {
    const { db } = await createTestDb();
    await seedApprovedRelease(db);
    const blocked = currentSources();
    blocked[2].state = "blocked";
    await runDataProductGateWatchdog(db, { dataSources: blocked });

    const recovered = await runDataProductGateWatchdog(db, {
      dataSources: currentSources(),
      now: new Date("2026-08-13T05:00:00Z"),
    });
    expect(recovered.autoClosed).toBe(1);

    const failedAgain = await runDataProductGateWatchdog(db, { dataSources: blocked });
    expect(failedAgain.opened).toBe(1);
    const alerts = await db.select().from(systemAlerts);
    expect(alerts).toHaveLength(2);
    expect(alerts.filter((row) => row.status === "resolved")).toHaveLength(1);
    expect(alerts.filter((row) => row.status === "open")).toHaveLength(1);
  });
});
