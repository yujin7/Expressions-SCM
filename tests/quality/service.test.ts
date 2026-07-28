import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auditLogs,
  batches,
  batchStocks,
  electronicLabelVersions,
  qualityActions,
  qualityCases,
  regulatoryRecords,
  skus,
  spus,
  stockBalances,
  stockLedger,
  stockSnapshots,
  suppliers,
  sysParams,
  users,
  warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  createQualityAction,
  createQualityCase,
  createRegulatoryRecord,
  getPublicElectronicLabel,
  listElectronicLabels,
  listQualityActions,
  listQualityCases,
  listRegulatoryRecords,
  publishElectronicLabel,
  transitionQualityAction,
  transitionQualityCase,
} from "@/server/modules/quality/service";
import { canonicalJsonSha256 } from "@/server/rules/quality-compliance";
import { createTestDb, type TestDb } from "../helpers/db";

interface QualityFixture {
  db: TestDb;
  quality: SessionUser;
  verifier: SessionUser;
  ops: SessionUser;
  admin: SessionUser;
  skuId: number;
  batchId: number;
  warehouseId: number;
  supplierId: number;
}

async function makeFixture(): Promise<QualityFixture> {
  const { db } = await createTestDb();
  const makeUser = async (name: string, roles: string[]): Promise<SessionUser> => {
    const [row] = await db.insert(users).values({ name, roles, isApprover: true }).returning();
    return { id: row.id, name, roles, isApprover: true };
  };
  const quality = await makeUser("质量负责人", ["quality"]);
  const verifier = await makeUser("质量复核人", ["quality"]);
  const ops = await makeUser("运营登记人", ["ops"]);
  const admin = await makeUser("系统管理员", ["admin"]);
  const [spu] = await db.insert(spus).values({ code: "P-QA-01", nameCn: "质量测试产品" }).returning();
  const [sku] = await db.insert(skus).values({
    code: "QA-SKU-01",
    name: "质量测试面膜",
    spuId: spu.id,
    baseUom: "盒",
    skuType: "finished",
  }).returning();
  const [supplier] = await db.insert(suppliers).values({
    code: "QA-SUP-01",
    name: "质量测试供应商",
    kinds: ["processor"],
    status: "qualified",
  }).returning();
  const [warehouse] = await db.insert(warehouses).values({
    code: "QA-WH-01",
    name: "质量测试仓",
    kind: "finished",
    accountingMode: "realtime",
  }).returning();
  const [batch] = await db.insert(batches).values({
    batchNo: "LOT-QA-001",
    skuId: sku.id,
    prodDate: "2026-01-02",
    expiryDate: "2028-01-01",
    sourceDocType: "sh",
    sourceDocId: 42,
  }).returning();
  return {
    db,
    quality,
    verifier,
    ops,
    admin,
    skuId: sku.id,
    batchId: batch.id,
    warehouseId: warehouse.id,
    supplierId: supplier.id,
  };
}

function caseInput(f: QualityFixture, overrides: Record<string, unknown> = {}) {
  return {
    kind: "complaint",
    severity: "high",
    marketCode: "US",
    title: "消费者使用后出现严重不适",
    summary: "运营登记外部受限工单，等待质量负责人判断严重性与可报告性。",
    sourceChannel: "consumer",
    externalRef: "restricted-case/AE-001",
    skuId: f.skuId,
    batchId: f.batchId,
    supplierId: f.supplierId,
    warehouseId: f.warehouseId,
    ownerId: f.quality.id,
    receivedDate: "2026-07-02",
    occurredDate: "2026-07-01",
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function createAction(
  f: QualityFixture,
  caseId: number,
  kind: string,
  overrides: Record<string, unknown> = {},
) {
  return createQualityAction(f.quality, caseId, {
    kind,
    title: `${kind} 质量行动`,
    description: `执行并保留 ${kind} 的受控证据与结果。`,
    ownerId: f.quality.id,
    dueDate: "2026-08-31",
    idempotencyKey: randomUUID(),
    ...(kind === "notification" ? { targetType: "channel", targetRef: "all-known-channels" } : {}),
    ...(kind === "reconciliation" ? { quantity: "12.0000" } : {}),
    ...overrides,
  }, f.db);
}

async function resolveAction(
  f: QualityFixture,
  action: { id: number },
  result: "verified" | "ineffective" | "waived" = "verified",
) {
  const completed = await transitionQualityAction(f.quality, action.id, {
    operation: "complete",
    evidenceRef: `evidence/action-${action.id}`,
    outcome: "行动已执行并形成可复核证据。",
  }, f.db);
  expect(completed.status).toBe("completed");
  return transitionQualityAction(result === "waived" ? f.admin : f.verifier, action.id, {
    operation: "verify",
    result,
    verificationNote: result === "verified" ? "独立复核证据充分且行动有效。" : "独立复核结论已记录。",
  }, f.db);
}

describe("complaint and serious adverse-event control", () => {
  let f: QualityFixture;

  beforeAll(async () => {
    f = await makeFixture();
  });

  it("keeps intake unassessed, linked and idempotent without storing consumer PII", async () => {
    const key = randomUUID();
    const input = caseInput(f, { idempotencyKey: key });
    const first = await createQualityCase(f.ops, input, f.db);
    const replay = await createQualityCase(f.ops, input, f.db);

    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({
      kind: "complaint",
      assessment: "unassessed",
      skuId: f.skuId,
      batchId: f.batchId,
      supplierId: f.supplierId,
      externalRef: "restricted-case/AE-001",
    });
    expect(Object.keys(first)).not.toContain("consumerName");
    expect(await f.db.select().from(qualityCases).where(eq(qualityCases.idempotencyKey, key))).toHaveLength(1);
    expect(await f.db.select().from(auditLogs).where(eq(auditLogs.entityId, first.id))).toHaveLength(1);

    await expect(transitionQualityCase(f.quality, first.id, {
      operation: "close",
      expectedVersion: 1,
      rootCause: "尚未完成人工严重性判断。",
      closureNote: "未评估投诉不应被直接关闭。",
    }, f.db)).rejects.toMatchObject({ status: 409 });

    await expect(createQualityCase(f.ops, {
      ...input,
      title: "同一幂等键却是另一宗投诉",
    }, f.db)).rejects.toMatchObject({ status: 409 });

    const concurrentInput = caseInput(f, { idempotencyKey: randomUUID() });
    const [left, right] = await Promise.all([
      createQualityCase(f.ops, concurrentInput, f.db),
      createQualityCase(f.ops, concurrentInput, f.db),
    ]);
    expect(left.id).toBe(right.id);

    const restricted = await listQualityCases(f.ops, { q: first.caseNo }, f.db);
    expect(restricted.rows[0]).toMatchObject({
      id: first.id,
      title: "受限投诉/不良事件案件",
      summary: "受限投诉/不良事件案件；详细叙述仅质量合规角色可见。",
      externalRef: null,
      assessmentBasis: null,
      regulatorRef: null,
      rootCause: null,
    });
    expect((await listQualityCases(f.ops, { q: "消费者使用后出现严重不适" }, f.db)).total).toBe(0);
    expect((await listQualityCases(f.ops, { q: "运营登记外部受限工单" }, f.db)).total).toBe(0);
    expect((await listQualityCases(f.quality, { q: "消费者使用后出现严重不适" }, f.db)).rows)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id })]));
    const unrestricted = await listQualityCases(f.quality, { q: first.caseNo }, f.db);
    expect(unrestricted.rows[0]).toMatchObject({
      id: first.id,
      summary: input.summary,
      externalRef: input.externalRef,
    });
  });

  it("requires a human assessment, escalates a reportable complaint and calculates US controls", async () => {
    const created = await createQualityCase(f.ops, caseInput(f), f.db);
    const assessed = await transitionQualityCase(f.quality, created.id, {
      operation: "assess",
      expectedVersion: 1,
      assessment: "serious_reportable",
      basis: "质量负责人依据外部受限病例证据判断属于美国可报告严重不良事件。",
    }, f.db);

    expect(assessed).toMatchObject({
      kind: "adverse_event",
      status: "triaged",
      assessment: "serious_reportable",
      reportPolicy: "FDA_MOCRA_2022",
      reportDueDate: "2026-07-24",
      retentionUntil: "2032-07-02",
    });
    expect(assessed.assessmentBasis).toContain("质量负责人");
    const [followUp] = await f.db.select().from(qualityActions)
      .where(and(
        eq(qualityActions.caseId, created.id),
        eq(qualityActions.kind, "follow_up"),
      ));
    expect(followUp).toMatchObject({
      dueDate: "2027-07-02",
      status: "open",
      targetType: "regulatory_case",
      targetRef: assessed.caseNo,
    });
    await expect(transitionQualityAction(f.quality, followUp.id, {
      operation: "complete",
      evidenceRef: "evidence/follow-up-premature",
      outcome: "试图在一年监测窗口结束前提前关闭。",
    }, f.db)).rejects.toMatchObject({ status: 409 });
    await expect(f.db.update(qualityActions).set({
      dueDate: "2026-07-02",
    }).where(eq(qualityActions.id, followUp.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("monitoring deadline are immutable") },
    });
    await expect(f.db.update(qualityActions).set({
      status: "completed",
      evidenceRef: "evidence/follow-up-direct-sql",
      outcome: "直接 SQL 也不能绕过一年监测窗口。",
      completedBy: f.quality.id,
      completedAt: new Date(),
    }).where(eq(qualityActions.id, followUp.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("follow-up window is still open") },
    });

    await expect(transitionQualityCase(f.quality, created.id, {
      operation: "assess",
      expectedVersion: 2,
      assessment: "non_serious",
      basis: "试图在提交监管报告前覆盖已经固化的人工严重性结论。",
    }, f.db)).rejects.toMatchObject({ status: 409 });

    await expect(transitionQualityCase(f.quality, created.id, {
      operation: "report",
      expectedVersion: 2,
      regulatorRef: "FDA-AER-001",
      reportedAt: "2099-01-01T00:00:00.000Z",
    }, f.db)).rejects.toMatchObject({ status: 400 });

    const reported = await transitionQualityCase(f.quality, created.id, {
      operation: "report",
      expectedVersion: 2,
      regulatorRef: "FDA-AER-001",
      reportedAt: "2026-07-20T08:00:00.000Z",
    }, f.db);
    expect(reported.reportedAt).toBeTruthy();
    await expect(f.db.update(qualityCases).set({
      assessmentBasis: "试图通过直接 SQL 覆盖已经固化的人工判断。",
    }).where(eq(qualityCases.id, created.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("assessment evidence is immutable") },
    });
    await expect(f.db.update(qualityCases).set({
      regulatorRef: "FDA-AER-TAMPERED",
    }).where(eq(qualityCases.id, created.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("regulatory report evidence is immutable") },
    });

    await expect(transitionQualityCase(f.quality, created.id, {
      operation: "assess",
      expectedVersion: 3,
      assessment: "non_serious",
      basis: "试图覆盖已经提交监管机构的严重性结论。",
    }, f.db)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects impossible calendar dates at the service boundary", async () => {
    await expect(createQualityCase(f.ops, caseInput(f, {
      receivedDate: "2026-02-30",
    }), f.db)).rejects.toThrow(/日期必须是真实存在的日历日期/);
  });

  it("does not accept guessed or backward non-US report controls", async () => {
    const created = await createQualityCase(f.ops, caseInput(f, {
      marketCode: "CN",
      batchId: undefined,
      kind: "adverse_event",
    }), f.db);
    await expect(transitionQualityCase(f.quality, created.id, {
      operation: "assess",
      expectedVersion: 1,
      assessment: "serious_reportable",
      basis: "质量负责人确认需要按照当前中国市场政策进一步报告。",
    }, f.db)).rejects.toMatchObject({ status: 400 });
    await expect(transitionQualityCase(f.quality, created.id, {
      operation: "assess",
      expectedVersion: 1,
      assessment: "serious_reportable",
      basis: "质量负责人确认需要按照当前中国市场政策进一步报告。",
      policy: "CN-AE-POLICY-V1",
      reportDueDate: "2026-07-01",
      retentionUntil: "2026-07-01",
    }, f.db)).rejects.toMatchObject({ status: 400 });
  });
});

describe("CAPA segregation and effectiveness closure", () => {
  let f: QualityFixture;
  let caseId = 0;

  beforeAll(async () => {
    f = await makeFixture();
    const created = await createQualityCase(f.quality, caseInput(f, {
      kind: "adverse_event",
      batchId: undefined,
      marketCode: "CN",
    }), f.db);
    const assessed = await transitionQualityCase(f.quality, created.id, {
      operation: "assess",
      expectedVersion: 1,
      assessment: "serious_not_reportable",
      basis: "质量负责人完成严重性与可报告性判断，当前证据不足以触发监管报告。",
    }, f.db);
    caseId = assessed.id;
  });

  it("requires independent verification and preserves an ineffective result", async () => {
    const corrective = await createAction(f, caseId, "corrective", {
      targetType: "restricted_evidence",
      targetRef: "restricted/action/CAPA-001",
    });
    await transitionQualityAction(f.quality, corrective.id, {
      operation: "complete",
      evidenceRef: "evidence/corrective-001",
      outcome: "纠正行动已完成。",
    }, f.db);
    await expect(f.db.update(qualityActions).set({
      evidenceRef: "evidence/tampered-before-verification",
    }).where(eq(qualityActions.id, corrective.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("completion evidence is immutable") },
    });
    await expect(transitionQualityAction(f.quality, corrective.id, {
      operation: "verify",
      result: "verified",
      verificationNote: "自己验证自己的行动不应被允许。",
    }, f.db)).rejects.toMatchObject({ status: 409 });
    const ineffective = await transitionQualityAction(f.verifier, corrective.id, {
      operation: "verify",
      result: "ineffective",
      verificationNote: "独立验证发现行动未消除根因。",
    }, f.db);
    expect(ineffective.status).toBe("ineffective");
    const restricted = await listQualityActions(f.ops, caseId, f.db);
    expect(restricted.find((row: { id: number }) => row.id === corrective.id)).toMatchObject({
      title: "受限投诉/不良事件行动",
      description: "行动说明仅质量合规角色可见。",
      targetRef: null,
      outcome: null,
      evidenceRef: null,
      verificationNote: null,
    });
    const unrestricted = await listQualityActions(f.quality, caseId, f.db);
    expect(unrestricted.find((row: { id: number }) => row.id === corrective.id)).toMatchObject({
      targetRef: "restricted/action/CAPA-001",
      outcome: "纠正行动已完成。",
      evidenceRef: "evidence/corrective-001",
      verificationNote: "独立验证发现行动未消除根因。",
    });
    await expect(f.db.update(qualityActions).set({
      evidenceRef: "evidence/tampered-completion",
    }).where(eq(qualityActions.id, corrective.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("verified quality action evidence is immutable") },
    });
    await expect(f.db.update(qualityActions).set({
      verificationNote: "试图覆盖独立验证结论。",
    }).where(eq(qualityActions.id, corrective.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("verified quality action evidence is immutable") },
    });
    await expect(transitionQualityCase(f.quality, caseId, {
      operation: "close",
      expectedVersion: 2,
      rootCause: "供应商工艺控制参数没有被纳入受控版本。",
      closureNote: "试图在无有效行动时关闭案件。",
    }, f.db)).rejects.toMatchObject({ status: 409 });
  });

  it("requires a separately verified effectiveness action before closing a high-severity case", async () => {
    const corrective2 = await createAction(f, caseId, "corrective");
    const preventive = await createAction(f, caseId, "preventive");
    await resolveAction(f, corrective2);
    await resolveAction(f, preventive);

    await expect(transitionQualityCase(f.quality, caseId, {
      operation: "close",
      expectedVersion: 2,
      rootCause: "供应商工艺控制参数没有被纳入受控版本。",
      closureNote: "纠正预防均完成，但尚未独立验证效果。",
    }, f.db)).rejects.toMatchObject({ status: 409 });

    const effectiveness = await createAction(f, caseId, "effectiveness");
    await resolveAction(f, effectiveness);
    const unrelatedOpen = await createAction(f, caseId, "containment");
    await expect(transitionQualityCase(f.quality, caseId, {
      operation: "close",
      expectedVersion: 2,
      rootCause: "供应商工艺控制参数没有被纳入受控版本。",
      closureNote: "CAPA 已有效，但任何其他未完成行动仍必须阻止结案。",
    }, f.db)).rejects.toMatchObject({ status: 409 });
    await resolveAction(f, unrelatedOpen);
    const closed = await transitionQualityCase(f.quality, caseId, {
      operation: "close",
      expectedVersion: 2,
      rootCause: "供应商工艺控制参数没有被纳入受控版本。",
      closureNote: "CAPA 与独立有效性检查均完成，案件可关闭。",
    }, f.db);
    expect(closed.status).toBe("closed");
  });
});

describe("recall immutable scope and action gates", () => {
  let f: QualityFixture;
  let caseId = 0;

  beforeAll(async () => {
    f = await makeFixture();
    const [negativeWarehouse] = await f.db.insert(warehouses).values({
      code: "QA-WH-NEG",
      name: "质量负余额异常仓",
      kind: "finished",
      accountingMode: "realtime",
    }).returning();
    await f.db.insert(stockBalances).values([
      { skuId: f.skuId, warehouseId: f.warehouseId, batchId: f.batchId, qty: "12.0000" },
      { skuId: f.skuId, warehouseId: f.warehouseId, batchId: null, qty: "5.0000" },
      { skuId: f.skuId, warehouseId: negativeWarehouse.id, batchId: f.batchId, qty: "-3.0000" },
      { skuId: f.skuId, warehouseId: negativeWarehouse.id, batchId: null, qty: "-4.0000" },
    ]);
    await f.db.insert(stockLedger).values({
      skuId: f.skuId,
      warehouseId: f.warehouseId,
      batchId: f.batchId,
      qtyDelta: "12.0000",
      sourceDocType: "sh_receipt",
      sourceDocId: 42,
      sourceLineId: 1,
      action: "post",
    });
    await f.db.insert(batchStocks).values({
      skuId: f.skuId,
      warehouseId: f.warehouseId,
      batchNo: "LOT-QA-001",
      prodDate: "2026-01-02",
      expiryDate: "2028-01-01",
      qty: "7.0000",
      stocktakeDate: "2026-07-21",
      source: "expiry_import",
    });
    await f.db.insert(batchStocks).values({
      skuId: f.skuId,
      warehouseId: f.warehouseId,
      batchNo: "LOT-QA-001",
      prodDate: "2026-01-03",
      expiryDate: "2028-01-02",
      qty: "2.0000",
      stocktakeDate: "2026-07-21",
      source: "expiry_import",
    });
    await f.db.insert(stockSnapshots).values({
      skuId: f.skuId,
      warehouseId: f.warehouseId,
      bizDate: "2026-07-21",
      qty: "20.0000",
    });
    await f.db.insert(sysParams).values({
      scope: "global",
      key: "batch_posting_enabled",
      value: "0",
    });
    const created = await createQualityCase(f.quality, caseInput(f, {
      kind: "recall",
      severity: "critical",
      marketCode: "CN",
      title: "批次主动召回",
      summary: "对受影响成品批次启动范围确认、通知、有效性检查和数量核对。",
    }), f.db);
    caseId = created.id;
  });

  it("freezes a digest with known balances and explicit unknown downstream coverage", async () => {
    const frozen = await transitionQualityCase(f.quality, caseId, {
      operation: "freeze_scope",
      expectedVersion: 1,
      limitationNote: "线下经销商回执仍待人工补录。",
    }, f.db);
    const scope = frozen.scopeSnapshot as {
      authoritativeInternal: {
        totalQty: string;
        grossPositiveQty: string;
        grossNegativeQty: string;
        netQty: string;
        integrityWarnings: string[];
      };
      referenceOnly: {
        batchSnapshotTotalQty: string;
        batchSnapshots: unknown[];
        externalSkuSnapshotTotalQty: string;
      };
      unknownCoverage: {
        unbatchedInternalSkuQty: string;
        unbatchedGrossPositiveQty: string;
        unbatchedGrossNegativeQty: string;
        unbatchedNetQty: string;
        customerDestinations: string;
        batchPostingEnabled: boolean;
        limitations: string[];
      };
    };
    expect(frozen.status).toBe("scoped");
    expect(scope.authoritativeInternal).toMatchObject({
      totalQty: "12.0000",
      grossPositiveQty: "12.0000",
      grossNegativeQty: "3.0000",
      netQty: "9.0000",
    });
    expect(scope.authoritativeInternal.integrityWarnings.join(" ")).toContain("不得抵减暴露量");
    expect(scope.referenceOnly.batchSnapshots).toHaveLength(2);
    expect(scope.referenceOnly.batchSnapshotTotalQty).toBe("9.0000");
    expect(scope.referenceOnly.externalSkuSnapshotTotalQty).toBe("20.0000");
    expect(scope.unknownCoverage).toMatchObject({
      unbatchedInternalSkuQty: "5.0000",
      unbatchedGrossPositiveQty: "5.0000",
      unbatchedGrossNegativeQty: "4.0000",
      unbatchedNetQty: "1.0000",
      customerDestinations: "unavailable",
      batchPostingEnabled: false,
    });
    expect(scope.unknownCoverage.limitations.join(" ")).toContain("不会因缺失事实而缩小");
    expect(scope.unknownCoverage.limitations).toContain("线下经销商回执仍待人工补录。");
    expect(frozen.scopeDigest).toBe(canonicalJsonSha256(frozen.scopeSnapshot as never));

    await expect(f.db.update(qualityCases).set({
      scopeSnapshot: { tampered: true },
    }).where(eq(qualityCases.id, caseId))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("scope is frozen") },
    });
    await expect(f.db.update(qualityCases).set({
      batchId: null,
    }).where(eq(qualityCases.id, caseId))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("scope is frozen") },
    });
  });

  it("cannot activate without all four recall workstreams or close before verification", async () => {
    await expect(transitionQualityCase(f.quality, caseId, {
      operation: "activate",
      expectedVersion: 2,
    }, f.db)).rejects.toMatchObject({ status: 409 });

    await expect(createAction(f, caseId, "reconciliation", {
      quantity: "0",
    })).rejects.toMatchObject({ status: 409 });

    const actions = [];
    for (const kind of ["containment", "notification", "effectiveness", "reconciliation"]) {
      actions.push(await createAction(f, caseId, kind));
    }
    const reconciliation = actions.find((row) => row.kind === "reconciliation");
    const frozenCase = (await f.db.select().from(qualityCases)
      .where(eq(qualityCases.id, caseId)))[0];
    expect(reconciliation).toMatchObject({
      quantity: "12.0000",
      targetType: "recall_scope_digest",
      targetRef: frozenCase.scopeDigest,
    });
    const active = await transitionQualityCase(f.quality, caseId, {
      operation: "activate",
      expectedVersion: 2,
    }, f.db);
    expect(active.status).toBe("active");
    await expect(transitionQualityCase(f.quality, caseId, {
      operation: "close",
      expectedVersion: 3,
      rootCause: "批次稳定性偏差触发主动召回。",
      closureNote: "召回行动尚未验证时不能关闭。",
    }, f.db)).rejects.toMatchObject({ status: 409 });

    const mandatory = actions[0];
    await transitionQualityAction(f.quality, mandatory.id, {
      operation: "complete",
      evidenceRef: `evidence/action-${mandatory.id}`,
      outcome: "行动已执行并形成可复核证据。",
    }, f.db);
    await expect(transitionQualityAction(f.admin, mandatory.id, {
      operation: "verify",
      result: "waived",
      verificationNote: "即使管理员给出理由，召回强制行动也不得豁免。",
    }, f.db)).rejects.toMatchObject({ status: 409 });
    for (const action of actions) await resolveAction(f, action);
    const closed = await transitionQualityCase(f.quality, caseId, {
      operation: "close",
      expectedVersion: 3,
      rootCause: "批次稳定性偏差触发主动召回。",
      closureNote: "范围、通知、有效性和数量核对均已独立验证。",
    }, f.db);
    expect(closed.status).toBe("closed");
  });

  it("rejects hard deletion of retained cases and actions", async () => {
    await expect(f.db.delete(qualityActions).where(eq(qualityActions.caseId, caseId))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("retained evidence") },
    });
    await expect(f.db.delete(qualityCases).where(eq(qualityCases.id, caseId))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("retained evidence") },
    });
  });
});

describe("annual GMP self-inspection", () => {
  let f: QualityFixture;

  beforeAll(async () => {
    f = await makeFixture();
  });

  it("retains the annual report and findings, and blocks closure until findings are verified", async () => {
    const created = await createQualityCase(f.quality, caseInput(f, {
      kind: "self_inspection",
      batchId: undefined,
      severity: "medium",
      marketCode: "CN",
      title: "2026 年度 GMP 自查",
      summary: "按年度对生产场所执行化妆品生产质量管理规范自查。",
      receivedDate: "2026-07-29",
      occurredDate: undefined,
      inspectionYear: 2026,
      inspectionSite: "广州 OEM 一厂",
    }), f.db);
    expect(created).toMatchObject({
      inspectionReportRef: null,
      inspectionReportDate: null,
      retentionUntil: null,
    });
    const documented = await transitionQualityCase(f.quality, created.id, {
      operation: "document_inspection",
      expectedVersion: 1,
      inspectionReportRef: "gmp-report/2026/GZ-01",
      reportDate: "2026-07-29",
      rootCause: "自查识别标签放行记录抽样证据不完整。",
    }, f.db);
    expect(documented).toMatchObject({
      status: "triaged",
      inspectionReportRef: "gmp-report/2026/GZ-01",
      inspectionReportDate: "2026-07-29",
      retentionUntil: "2028-07-29",
    });
    expect(documented).toMatchObject({
      inspectionSite: "广州 OEM 一厂",
      inspectionSiteKey: "广州 OEM 一厂",
    });
    await expect(f.db.update(qualityCases).set({
      inspectionReportRef: "gmp-report/2026/GZ-01-tampered",
    }).where(eq(qualityCases.id, created.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("GMP self-inspection report evidence is immutable") },
    });
    await expect(f.db.update(qualityCases).set({
      inspectionSite: "广州 OEM 二厂",
      inspectionSiteKey: "广州 OEM 二厂",
    }).where(eq(qualityCases.id, created.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("site identity is immutable") },
    });
    expect(await transitionQualityCase(f.quality, created.id, {
      operation: "document_inspection",
      expectedVersion: 2,
      inspectionReportRef: "gmp-report/2026/GZ-01",
      reportDate: "2026-07-29",
    }, f.db)).toMatchObject({ id: created.id, version: 2 });
    await expect(transitionQualityCase(f.quality, created.id, {
      operation: "document_inspection",
      expectedVersion: 2,
      inspectionReportRef: "gmp-report/2026/GZ-01-replacement",
      reportDate: "2026-07-28",
    }, f.db)).rejects.toMatchObject({ status: 409 });
    const finding = await createAction(f, created.id, "finding");
    await expect(transitionQualityCase(f.quality, created.id, {
      operation: "close",
      expectedVersion: 2,
      closureNote: "发现项尚未完成和复核。",
    }, f.db)).rejects.toMatchObject({ status: 409 });
    await resolveAction(f, finding);
    const closed = await transitionQualityCase(f.quality, created.id, {
      operation: "close",
      expectedVersion: 2,
      closureNote: "年度自查报告和发现项整改证据均已复核。",
    }, f.db);
    expect(closed).toMatchObject({
      status: "closed",
      inspectionReportRef: "gmp-report/2026/GZ-01",
      retentionUntil: "2028-07-29",
    });
    await expect(f.db.update(qualityCases).set({
      closureNote: "试图覆盖已经固化的结案证据。",
    }).where(eq(qualityCases.id, created.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("closed quality case evidence is immutable") },
    });

    await expect(createQualityCase(f.quality, caseInput(f, {
      kind: "self_inspection",
      batchId: undefined,
      severity: "medium",
      marketCode: "CN",
      title: "重复年度 GMP 自查",
      summary: "同一生产场所同一年度不能建立第二个受控年度自查案件。",
      receivedDate: "2026-07-29",
      occurredDate: undefined,
      inspectionYear: 2026,
      inspectionSite: "  广州   oem  一厂  ",
    }), f.db)).rejects.toMatchObject({ status: 409 });
  });
});

describe("immutable regulatory and public electronic-label versions", () => {
  let f: QualityFixture;

  beforeAll(async () => {
    f = await makeFixture();
  });

  const regulatoryInput = (f0: QualityFixture, overrides: Record<string, unknown> = {}) => ({
    recordKey: "CN-FILING-QA-SKU-01",
    recordType: "nmpa_filing",
    marketCode: "CN",
    skuId: f0.skuId,
    title: "质量测试面膜备案",
    authority: "NMPA",
    referenceNo: "国妆网备字 QA0001",
    status: "active",
    effectiveDate: "2026-01-01",
    expiryDate: "2030-12-31",
    renewalDueDate: "2030-09-30",
    retentionUntil: "2036-12-31",
    payload: { formulaVersion: "F1", labelVersion: "L1" },
    evidenceRef: "regulatory/CN/QA0001",
    idempotencyKey: randomUUID(),
    ...overrides,
  });

  const labelInput = (
    f0: QualityFixture,
    regulatoryRecordId: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    skuId: f0.skuId,
    marketCode: "CN",
    locale: "zh-CN",
    regulatoryRecordId,
    effectiveDate: "2026-07-29",
    content: {
      productName: "质量测试面膜",
      responsibleEntity: "测试化妆品有限公司",
      responsibleAddress: "广州市测试区质量大道 1 号",
      netContent: "25ml × 5片",
      ingredients: ["水", "甘油"],
      usage: "洁面后使用。",
      precautions: "如有不适请停止使用。",
      batchStatement: "批号见外包装。",
      durabilityStatement: "限期使用日期见外包装。",
      origin: "中国",
      registrationRef: "国妆网备字 QA0001",
    },
    idempotencyKey: randomUUID(),
    ...overrides,
  });

  it("appends regulatory versions, rejects idempotency collisions and prevents mutation", async () => {
    const key = randomUUID();
    const input = regulatoryInput(f, { idempotencyKey: key });
    const v1 = await createRegulatoryRecord(f.quality, input, f.db);
    const replay = await createRegulatoryRecord(f.quality, input, f.db);
    expect(replay.id).toBe(v1.id);
    expect(v1).toMatchObject({ version: 1, previousId: null });
    expect(v1.payloadDigest).toBe(canonicalJsonSha256(v1.payload as never));

    await expect(createRegulatoryRecord(f.quality, {
      ...input,
      title: "同一幂等键对应另一份证据",
    }, f.db)).rejects.toMatchObject({ status: 409 });

    const v2 = await createRegulatoryRecord(f.quality, regulatoryInput(f, {
      payload: { formulaVersion: "F1", labelVersion: "L2" },
      evidenceRef: "regulatory/CN/QA0001-v2",
    }), f.db);
    expect(v2).toMatchObject({ version: 2, previousId: v1.id });
    await expect(createRegulatoryRecord(f.quality, regulatoryInput(f, {
      marketCode: "US",
      authority: "FDA",
      payload: { formulaVersion: "F1", labelVersion: "L2-US" },
    }), f.db)).rejects.toMatchObject({ status: 409 });

    const v3 = await createRegulatoryRecord(f.quality, regulatoryInput(f, {
      status: "submitted",
      effectiveDate: undefined,
      expiryDate: undefined,
      renewalDueDate: undefined,
      payload: { formulaVersion: "F1", labelVersion: "L3-DRAFT" },
      evidenceRef: "regulatory/CN/QA0001-v3-submitted",
    }), f.db);
    expect(v3).toMatchObject({ version: 3, previousId: v2.id, status: "submitted" });

    const qualityList = await listRegulatoryRecords(f.quality, {
      q: "CN-FILING-QA-SKU-01",
    }, f.db);
    expect(qualityList.find((row: { version: number }) => row.version === 3)).toMatchObject({
      isLatestRevision: true,
      isOperative: false,
    });
    expect(qualityList.find((row: { version: number }) => row.version === 2)).toMatchObject({
      isLatestRevision: false,
      isOperative: true,
    });
    expect(qualityList.find((row: { version: number; payload: unknown }) =>
      row.version === 2)?.payload).not.toBeNull();
    const restrictedList = await listRegulatoryRecords(f.ops, {
      q: "CN-FILING-QA-SKU-01",
    }, f.db);
    expect(restrictedList.every((row: { payload: unknown; evidenceRef: unknown }) =>
      row.payload == null && row.evidenceRef == null)).toBe(true);

    await expect(f.db.insert(regulatoryRecords).values({
      recordKey: v3.recordKey,
      recordType: v3.recordType,
      marketCode: "US",
      skuId: v3.skuId,
      supplierId: v3.supplierId,
      title: "非法改变市场身份的监管证据",
      authority: v3.authority,
      referenceNo: v3.referenceNo,
      status: "active",
      effectiveDate: v3.effectiveDate,
      expiryDate: v3.expiryDate,
      renewalDueDate: v3.renewalDueDate,
      retentionUntil: v3.retentionUntil,
      payload: v3.payload,
      payloadDigest: v3.payloadDigest,
      version: 4,
      previousId: v3.id,
      evidenceRef: "regulatory/CN/invalid-identity",
      idempotencyKey: randomUUID(),
      createdBy: f.quality.id,
    })).rejects.toMatchObject({
      cause: { message: expect.stringContaining("identity cannot change") },
    });

    await expect(f.db.insert(regulatoryRecords).values({
      recordKey: v1.recordKey,
      recordType: v1.recordType,
      marketCode: v1.marketCode,
      skuId: v1.skuId,
      supplierId: v1.supplierId,
      title: "非法跳版本监管证据",
      authority: v1.authority,
      referenceNo: v1.referenceNo,
      status: "active",
      effectiveDate: v1.effectiveDate,
      expiryDate: v1.expiryDate,
      renewalDueDate: v1.renewalDueDate,
      retentionUntil: v1.retentionUntil,
      payload: v1.payload,
      payloadDigest: v1.payloadDigest,
      version: 4,
      previousId: v1.id,
      evidenceRef: "regulatory/CN/invalid-chain",
      idempotencyKey: randomUUID(),
      createdBy: f.quality.id,
    })).rejects.toMatchObject({
      cause: { message: expect.stringContaining("prior version") },
    });
    await expect(f.db.update(regulatoryRecords).set({ title: "tampered" })
      .where(eq(regulatoryRecords.id, v1.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only") },
    });
    await expect(f.db.delete(regulatoryRecords)
      .where(eq(regulatoryRecords.id, v1.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only") },
    });
  });

  it("rejects facility-level and unscoped dossiers as product-label support", async () => {
    const facility = await createRegulatoryRecord(f.quality, regulatoryInput(f, {
      recordKey: "CN-FACILITY-NOT-LABEL-SUPPORT",
      recordType: "fda_facility",
      skuId: undefined,
      authority: "FDA",
      referenceNo: "FACILITY-001",
      payload: { facility: "OEM-01" },
      evidenceRef: "regulatory/facility/OEM-01",
    }), f.db);
    await expect(publishElectronicLabel(f.quality, labelInput(f, facility.id, {
      content: {
        ...labelInput(f, facility.id).content,
        registrationRef: "FACILITY-001",
      },
    }), f.db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("证据类型"),
    });

    const unscopedFiling = await createRegulatoryRecord(f.quality, regulatoryInput(f, {
      recordKey: "CN-FILING-UNSCOPED",
      skuId: undefined,
      referenceNo: "国妆网备字 UNSCOPED",
      payload: { formulaVersion: "F-UNSCOPED" },
      evidenceRef: "regulatory/CN/UNSCOPED",
    }), f.db);
    await expect(publishElectronicLabel(f.quality, labelInput(f, unscopedFiling.id, {
      content: {
        ...labelInput(f, unscopedFiling.id).content,
        registrationRef: "国妆网备字 UNSCOPED",
      },
    }), f.db)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("同一 SKU"),
    });
  });

  it("lets a newer terminal revision revoke an older active dossier and its public label", async () => {
    const recordKey = "CN-FILING-QA-SKU-REVOKED";
    const referenceNo = "国妆网备字 QA-REVOKED";
    const active = await createRegulatoryRecord(f.quality, regulatoryInput(f, {
      recordKey,
      referenceNo,
      title: "将被撤销的旧版产品备案",
      payload: { formulaVersion: "F-REVOKED", decision: "active" },
      evidenceRef: "regulatory/CN/QA-REVOKED-active",
    }), f.db);
    const input = labelInput(f, active.id, {
      locale: "fr-CN",
      content: {
        ...labelInput(f, active.id).content,
        registrationRef: referenceNo,
      },
    });
    const label = await publishElectronicLabel(f.quality, input, f.db);
    expect(await getPublicElectronicLabel(label.publicToken, f.db)).toMatchObject({
      lifecycleState: "current",
      isCurrent: true,
    });

    const revoked = await createRegulatoryRecord(f.quality, regulatoryInput(f, {
      recordKey,
      referenceNo,
      title: "监管撤销决定",
      status: "superseded",
      effectiveDate: "2026-07-29",
      payload: { formulaVersion: "F-REVOKED", decision: "superseded" },
      evidenceRef: "regulatory/CN/QA-REVOKED-revoked",
    }), f.db);
    expect(revoked).toMatchObject({ version: 2, previousId: active.id, status: "superseded" });

    expect(await getPublicElectronicLabel(label.publicToken, f.db)).toMatchObject({
      lifecycleState: "blocked",
      isCurrent: false,
      regulatorySupportState: "not_operative",
    });
    const revisions = await listRegulatoryRecords(f.quality, { q: recordKey }, f.db);
    expect(revisions.every((row: { isOperative: boolean }) => !row.isOperative)).toBe(true);
    const oldRevisionOnly = await listRegulatoryRecords(f.quality, { q: "将被撤销的旧版" }, f.db);
    expect(oldRevisionOnly).toMatchObject([{ version: 1, isOperative: false }]);
  });

  it("publishes only against the latest active dossier and keeps every public token immutable", async () => {
    const [v1, v2, v3] = await f.db.select().from(regulatoryRecords)
      .where(eq(regulatoryRecords.recordKey, "CN-FILING-QA-SKU-01"))
      .orderBy(regulatoryRecords.version);
    expect(v3.status).toBe("submitted");
    await expect(publishElectronicLabel(f.quality, labelInput(f, v1.id), f.db))
      .rejects.toMatchObject({ status: 409 });

    const key = randomUUID();
    const input = labelInput(f, v2.id, { idempotencyKey: key });
    await expect(publishElectronicLabel(f.quality, labelInput(f, v2.id, {
      content: {
        ...labelInput(f, v2.id).content,
        registrationRef: "另一个备案编号",
      },
    }), f.db)).rejects.toMatchObject({ status: 400 });
    const labelV1 = await publishElectronicLabel(f.quality, input, f.db);
    const replay = await publishElectronicLabel(f.quality, input, f.db);
    expect(replay).toMatchObject({ id: labelV1.id, publicPath: labelV1.publicPath });
    expect(await f.db.select().from(electronicLabelVersions)
      .where(eq(electronicLabelVersions.idempotencyKey, key))).toHaveLength(1);

    await expect(publishElectronicLabel(f.quality, {
      ...input,
      content: { ...input.content, netContent: "30ml × 5片" },
    }, f.db)).rejects.toMatchObject({ status: 409 });
    await expect(publishElectronicLabel(f.quality, labelInput(f, v2.id, {
      effectiveDate: "2026-07-28",
      content: { ...input.content, netContent: "25ml × 4片" },
    }), f.db)).rejects.toMatchObject({ status: 400 });

    await f.db.update(skus).set({
      code: "QA-SKU-RENAMED",
      name: "质量测试面膜（主档更名）",
    }).where(eq(skus.id, f.skuId));

    const replayAfterMasterRename = await publishElectronicLabel(f.quality, input, f.db);
    expect(replayAfterMasterRename).toMatchObject({
      id: labelV1.id,
      publicToken: labelV1.publicToken,
      contentDigest: labelV1.contentDigest,
    });

    const publicV1 = await getPublicElectronicLabel(labelV1.publicToken, f.db);
    expect(publicV1).toMatchObject({
      schemaVersion: "public-cosmetics-electronic-label/v1",
      sku: { code: "QA-SKU-01", name: "质量测试面膜" },
      marketCode: "CN",
      version: 1,
      isCurrent: true,
      regulatorySupportState: "active",
      content: { netContent: "25ml × 5片" },
    });
    expect(publicV1.notice).toContain("试点");
    expect(publicV1.digest).toBe(labelV1.contentDigest);
    expect(publicV1).not.toHaveProperty("regulatoryRecordId");
    expect(publicV1).not.toHaveProperty("publicToken");
    expect(publicV1.content).not.toHaveProperty("schemaVersion");

    const labelV2 = await publishElectronicLabel(f.quality, labelInput(f, v2.id, {
      content: { ...input.content, netContent: "25ml × 6片" },
    }), f.db);
    expect(labelV2).toMatchObject({ version: 2, previousId: labelV1.id });
    expect((await getPublicElectronicLabel(labelV1.publicToken, f.db)).isCurrent).toBe(false);
    expect((await getPublicElectronicLabel(labelV2.publicToken, f.db)).isCurrent).toBe(true);

    const scheduled = await publishElectronicLabel(f.quality, labelInput(f, v2.id, {
      effectiveDate: "2026-08-31",
      content: { ...input.content, netContent: "25ml × 7片" },
    }), f.db);
    expect(await getPublicElectronicLabel(scheduled.publicToken, f.db)).toMatchObject({
      lifecycleState: "scheduled",
      isCurrent: false,
    });
    expect(await getPublicElectronicLabel(labelV2.publicToken, f.db)).toMatchObject({
      lifecycleState: "current",
      isCurrent: true,
    });
    const replacementScheduled = await publishElectronicLabel(f.quality, labelInput(f, v2.id, {
      effectiveDate: "2026-09-30",
      content: { ...input.content, netContent: "25ml × 8片" },
    }), f.db);
    expect(await getPublicElectronicLabel(scheduled.publicToken, f.db)).toMatchObject({
      lifecycleState: "historical",
      isCurrent: false,
    });
    expect(await getPublicElectronicLabel(replacementScheduled.publicToken, f.db)).toMatchObject({
      lifecycleState: "scheduled",
      isCurrent: false,
    });
    const listedAll = await listElectronicLabels(f.quality, { skuId: f.skuId, marketCode: "CN" }, f.db);
    const listed = listedAll.filter((row: { labelKey: string }) =>
      row.labelKey === `${f.skuId}:CN:zh-CN`);
    expect(listed.map((row: { version: number; lifecycleState: string; isCurrent: boolean }) =>
      [row.version, row.lifecycleState, row.isCurrent])).toEqual([
      [4, "scheduled", false],
      [3, "historical", false],
      [2, "current", true],
      [1, "historical", false],
    ]);

    await expect(f.db.insert(electronicLabelVersions).values({
      labelKey: replacementScheduled.labelKey,
      skuId: replacementScheduled.skuId,
      marketCode: "US",
      locale: replacementScheduled.locale,
      regulatoryRecordId: replacementScheduled.regulatoryRecordId,
      version: 5,
      previousId: replacementScheduled.id,
      publicToken: randomUUID().replaceAll("-", ""),
      content: replacementScheduled.content,
      contentDigest: replacementScheduled.contentDigest,
      effectiveDate: "2026-10-31",
      idempotencyKey: randomUUID(),
      createdBy: f.quality.id,
    })).rejects.toMatchObject({
      cause: { message: expect.stringContaining("identity cannot change") },
    });

    await expect(f.db.insert(electronicLabelVersions).values({
      labelKey: labelV1.labelKey,
      skuId: labelV1.skuId,
      marketCode: labelV1.marketCode,
      locale: labelV1.locale,
      regulatoryRecordId: labelV1.regulatoryRecordId,
      version: 5,
      previousId: labelV1.id,
      publicToken: randomUUID().replaceAll("-", ""),
      content: labelV1.content,
      contentDigest: labelV1.contentDigest,
      effectiveDate: "2026-10-31",
      idempotencyKey: randomUUID(),
      createdBy: f.quality.id,
    })).rejects.toMatchObject({
      cause: { message: expect.stringContaining("prior version") },
    });

    await expect(f.db.update(electronicLabelVersions).set({ effectiveDate: "2027-01-01" })
      .where(eq(electronicLabelVersions.id, labelV1.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only") },
    });
    await expect(f.db.delete(electronicLabelVersions)
      .where(eq(electronicLabelVersions.id, labelV1.id))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only") },
    });
  });

  it("blocks a formerly valid public label once its supporting dossier has expired", async () => {
    const expiredDossier = await createRegulatoryRecord(f.quality, regulatoryInput(f, {
      recordKey: "CN-FILING-QA-SKU-01-EXPIRED",
      referenceNo: "国妆网备字 QA-EXPIRED",
      expiryDate: "2026-07-28",
      renewalDueDate: "2026-07-01",
      evidenceRef: "regulatory/CN/QA-EXPIRED",
    }), f.db);
    const label = await publishElectronicLabel(f.quality, labelInput(f, expiredDossier.id, {
      locale: "en-CN",
      effectiveDate: "2026-07-28",
      content: {
        ...labelInput(f, expiredDossier.id).content,
        registrationRef: "国妆网备字 QA-EXPIRED",
      },
    }), f.db);

    expect(await getPublicElectronicLabel(label.publicToken, f.db)).toMatchObject({
      lifecycleState: "blocked",
      isCurrent: false,
      regulatorySupportState: "expired",
    });
  });

  it("rejects truncation of all retained evidence tables", async () => {
    await expect(f.db.execute(sql.raw("TRUNCATE electronic_label_versions"))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only") },
    });
    await expect(f.db.execute(sql.raw(
      "TRUNCATE regulatory_records, electronic_label_versions",
    ))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only") },
    });
    await expect(f.db.execute(sql.raw("TRUNCATE quality_actions"))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("retained evidence") },
    });
    await expect(f.db.execute(sql.raw("TRUNCATE quality_actions, quality_cases"))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("retained evidence") },
    });
  });
});
