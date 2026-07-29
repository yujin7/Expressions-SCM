import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import {
  buildDecisionEnvelope,
  DECISION_ENVELOPE_VERSION,
  digestDecisionEvidence,
} from "@/server/core/decision-envelope";
import { dAdd, dCmp, dQty, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import {
  diffPlanVersions,
  type PlanSnapshotLine,
  type PlanVersionDiffResult,
} from "@/server/rules/plan-version-diff";

import { getReplenishSuggestions } from "./service";

const PLAN_ENGINE_VERSION = "time-phased-v2";
const MAX_VERSIONS = 52;

export interface PlanningVersionDto {
  id: number;
  name: string;
  weekStart: string;
  engineVersion: string;
  lineCount: number;
  suggestedCount: number;
  suppressedCount: number;
  digest: string;
  createdBy: number;
  createdByName: string | null;
  createdAt: string;
  parameters: unknown;
  sourceMeta: unknown;
}

export interface PlanningVersionDiffDto extends PlanVersionDiffResult {
  current: PlanningVersionDto;
  base: PlanningVersionDto | null;
}

export const capturePlanningVersionSchema = z.object({
  name: z.string().trim().max(80).optional(),
  idempotencyKey: z.string().uuid(),
});

function weekStartOf(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, date));
  const weekday = value.getUTCDay();
  value.setUTCDate(value.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return value.toISOString().slice(0, 10);
}

function toDto(row: {
  id: number;
  name: string;
  weekStart: string;
  engineVersion: string;
  lineCount: number;
  suggestedCount: number;
  suppressedCount: number;
  digest: string;
  createdBy: number;
  createdByName?: string | null;
  createdAt: Date | string;
  parameters: unknown;
  sourceMeta: unknown;
}): PlanningVersionDto {
  return {
    ...row,
    createdByName: row.createdByName ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

const DECISION_LIMITATIONS = [
  "无确认到货日的供给保留为证据，但不进入逐日净需求推演。",
  "WO 在制按计划产出量记录，部分收货尚未净额化时可能高估。",
  "存量在途来自外部登记层，只作为参考证据，不等同系统记账承诺。",
  "需求基于历史动销与安全库存，不包含尚未接入的客户订单承诺，因此不是 ATP。",
] as const;

function snapshotLine(
  row: Awaited<ReturnType<typeof getReplenishSuggestions>>["rows"][number],
  context: {
    capturedAt: string;
    sourceMeta: Record<string, unknown>;
  },
) {
  const quantity = row.suggestQty ?? row.heldQty;
  if (quantity == null) return null;
  const { envelope, digest } = buildDecisionEnvelope({
    decisionKind: "replenishment_recommendation",
    engine: { key: "time_phased_replenishment", version: PLAN_ENGINE_VERSION },
    capturedAt: context.capturedAt,
    businessDate: row.decisionEvidence.businessDate,
    sourceMeta: context.sourceMeta,
    inputs: {
      sku: {
        id: row.skuId,
        code: row.code,
        name: row.name,
        brand: row.brand,
        baseUom: row.baseUom,
      },
      stock: {
        onHand: row.decisionEvidence.onHand,
        poInTransit: row.decisionEvidence.poInTransit,
        referenceOnHand: row.refQty,
        referenceOnOrder: row.onOrder,
        legacyTransit: row.legacyTransit,
        workInProgress: row.wipQty,
        borrowOut: row.borrowOut,
      },
      demand: {
        daily: row.decisionEvidence.daily,
        forecastDaily: row.forecastDaily,
        forecastTrend: row.forecastTrend,
        forecastTrusted: row.forecastTrusted,
        abcClass: row.abcClass,
        effectiveTargetDays: row.effectiveTarget,
      },
      policy: {
        safetyQty: row.decisionEvidence.safetyQty,
        safetyMethod: row.safetyMethod,
        leadDays: row.leadDays,
        productionLeadDays: row.productionLeadDays,
        logisticsLeadDays: row.logisticsLeadDays,
        actionWindowDays: row.decisionEvidence.actionWindowDays,
        horizonDays: row.decisionEvidence.horizonDays,
      },
      openSupply: row.decisionEvidence.supplyLines,
    },
    outputs: {
      shortageDate: row.shortageDate,
      daysToShortage: row.daysToShortage,
      orderByDate: row.orderByDate,
      orderWindowMissed: row.orderWindowMissed,
      targetLevel: row.decisionEvidence.targetLevel,
      demandQty: row.decisionEvidence.demandQty,
      netRequiredBeforeRounding: row.decisionEvidence.netRequiredQty,
      suggestedQty: quantity,
      suppressed: row.suggestQty == null,
      suppressReason: row.suppressReason,
    },
    explanations: row.planExplain,
    limitations: [...DECISION_LIMITATIONS],
  });
  return {
    skuId: row.skuId,
    skuCode: row.code,
    skuName: row.name,
    brand: row.brand,
    baseUom: row.baseUom,
    suggestedQty: quantity,
    suppressed: row.suggestQty == null,
    shortageDate: row.shortageDate,
    orderByDate: row.orderByDate,
    orderWindowMissed: row.orderWindowMissed,
    coverFull: row.coverFull == null ? null : String(row.coverFull),
    onHand: row.decisionEvidence.onHand,
    inTransit: row.decisionEvidence.poInTransit,
    daily: row.decisionEvidence.daily,
    safetyQty: row.decisionEvidence.safetyQty,
    leadDays: row.leadDays,
    explanation: row.planExplain,
    envelopeVersion: DECISION_ENVELOPE_VERSION,
    decisionEnvelope: envelope,
    evidenceDigest: digest,
    pegging: {
      demandDate: row.shortageDate,
      demandQty: row.decisionEvidence.demandQty,
      onHand: row.decisionEvidence.onHand,
      supplyLines: row.decisionEvidence.supplyLines,
      recommendationQty: quantity,
      suppressed: row.suggestQty == null,
    },
  };
}

type SnapshotDecisionLine = NonNullable<ReturnType<typeof snapshotLine>>;

function minQty(a: string, b: string): string {
  return dCmp(a, b) <= 0 ? dQty(a) : dQty(b);
}

function buildSupplyDemandLinks(
  versionId: number,
  planningLineId: number,
  line: SnapshotDecisionLine,
) {
  const demandDate = line.pegging.demandDate;
  if (!demandDate) return [];
  const demandQty = dQty(line.pegging.demandQty);
  let remaining = demandQty;
  let sequence = 0;
  const links: Array<typeof schema.supplyDemandLinks.$inferInsert> = [];

  const append = (source: {
    sourceType: string;
    sourceRef?: string | null;
    sourceDocId?: number | null;
    sourceLineId?: number | null;
    supplyDate?: string | null;
    availableQty: string;
    confidence: string;
    forcedStatus?: string;
    explanation: string;
  }) => {
    const available = dQty(source.availableQty);
    const eligible = source.forcedStatus == null && dCmp(remaining, "0") > 0;
    const pegged = eligible ? minQty(available, remaining) : "0.0000";
    if (dCmp(pegged, "0") > 0) remaining = dSub(remaining, pegged, 4);
    const status = source.forcedStatus
      ?? (dCmp(pegged, "0") === 0
        ? "excess"
        : dCmp(pegged, available) < 0
          ? "partial"
          : "pegged");
    links.push({
      versionId,
      planningLineId,
      skuId: line.skuId,
      demandType: "forecast_plus_safety",
      demandDate,
      demandQty,
      sourceType: source.sourceType,
      sourceRef: source.sourceRef ?? null,
      sourceDocId: source.sourceDocId ?? null,
      sourceLineId: source.sourceLineId ?? null,
      supplyDate: source.supplyDate ?? null,
      availableQty: available,
      peggedQty: pegged,
      confidence: source.confidence,
      status,
      sequence: sequence++,
      explanation: source.explanation,
    });
  };

  if (dCmp(line.pegging.onHand, "0") > 0) {
    append({
      sourceType: "on_hand",
      availableQty: line.pegging.onHand,
      confidence: "booked",
      explanation: "捕获时点全网记账在库，优先覆盖该需求桶。",
    });
  }

  for (const source of line.pegging.supplyLines) {
    const excludedStatus = source.expectDate == null
      ? "excluded_undated"
      : source.expectDate > demandDate
        ? "excluded_late"
        : undefined;
    append({
      sourceType: source.source,
      sourceRef: source.ref,
      sourceDocId: source.sourceDocId,
      sourceLineId: source.sourceLineId,
      supplyDate: source.expectDate,
      availableQty: source.qty,
      confidence: source.source === "legacy_fg" ? "reference" : "booked",
      forcedStatus: excludedStatus,
      explanation: excludedStatus === "excluded_undated"
        ? "没有确认到货日，不进入逐日净需求分配。"
        : excludedStatus === "excluded_late"
          ? `预计到货日晚于需求日 ${demandDate}，不覆盖该需求桶。`
          : "确认到货日在需求日前，按日期与来源顺序参与覆盖。",
    });
  }

  append({
    sourceType: line.pegging.suppressed ? "held_recommendation" : "recommended_replenishment",
    availableQty: line.pegging.recommendationQty,
    confidence: line.pegging.suppressed ? "suppressed" : "proposed",
    forcedStatus: line.pegging.suppressed ? "suppressed" : undefined,
    explanation: line.pegging.suppressed
      ? "建议因全口径覆盖缺口被抑制；保留原始量供人工核实，但不计入覆盖。"
      : "系统建议的拟补货量；仍须人工生成 BH 草稿并走正常审批。",
  });

  return links;
}

async function findVersionByIdempotency(
  db: AnyDb,
  idempotencyKey: string,
): Promise<PlanningVersionDto | null> {
  const [row] = await db
    .select({
      id: schema.planningVersions.id,
      name: schema.planningVersions.name,
      weekStart: schema.planningVersions.weekStart,
      engineVersion: schema.planningVersions.engineVersion,
      lineCount: schema.planningVersions.lineCount,
      suggestedCount: schema.planningVersions.suggestedCount,
      suppressedCount: schema.planningVersions.suppressedCount,
      digest: schema.planningVersions.digest,
      createdBy: schema.planningVersions.createdBy,
      createdAt: schema.planningVersions.createdAt,
      parameters: schema.planningVersions.parameters,
      sourceMeta: schema.planningVersions.sourceMeta,
    })
    .from(schema.planningVersions)
    .where(eq(schema.planningVersions.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ? toDto(row) : null;
}

/**
 * Capture the current all-SKU recommendation set.
 *
 * A retry with the same idempotency key returns the original version. Only the
 * winning insert writes lines and audit, all in one transaction.
 */
export async function capturePlanningVersion(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<PlanningVersionDto> {
  requireAnyRole(user, "pmc");
  const value = capturePlanningVersionSchema.parse(input);
  const db = await resolveDb(dbArg);
  const existing = await findVersionByIdempotency(db, value.idempotencyKey);
  if (existing) return existing;

  return db.transaction(async (tx: AnyDb) => {
    const suggestions = await getReplenishSuggestions({ allRows: true }, tx);
    const today = todayShanghai();
    const weekStart = weekStartOf(today);
    const capturedAt = new Date().toISOString();
    const parameters = {
      coverDaysTarget: suggestions.meta.coverDaysTarget,
      minCoverAlert: suggestions.meta.minCoverAlert,
      serviceLevel: suggestions.meta.serviceLevel,
      engine: suggestions.meta.engine,
    };
    const sourceMeta = {
      months3: suggestions.meta.months3,
      snapshotDate: suggestions.meta.snapDate,
      referenceDate: suggestions.meta.refDate,
      capturedBusinessDate: today,
      activeSkuCount: suggestions.total,
      envelopeSchemaVersion: DECISION_ENVELOPE_VERSION,
      limitations: [...DECISION_LIMITATIONS],
    };
    const lines = suggestions.rows
      .map((row) => snapshotLine(row, { capturedAt, sourceMeta }))
      .filter((line): line is NonNullable<typeof line> => line != null)
      .sort((a, b) => a.skuId - b.skuId);
    const digest = digestDecisionEvidence({
      engineVersion: PLAN_ENGINE_VERSION,
      parameters,
      sourceMeta,
      lineEvidence: lines.map((line) => line.evidenceDigest),
    });
    const [created] = await tx
      .insert(schema.planningVersions)
      .values({
        name: value.name?.trim() || `${weekStart} 周计划`,
        weekStart,
        engineVersion: PLAN_ENGINE_VERSION,
        parameters,
        sourceMeta,
        lineCount: lines.length,
        suggestedCount: lines.filter((line) => !line.suppressed).length,
        suppressedCount: lines.filter((line) => line.suppressed).length,
        digest,
        idempotencyKey: value.idempotencyKey,
        createdBy: user.id,
      })
      .onConflictDoNothing({ target: schema.planningVersions.idempotencyKey })
      .returning();

    if (!created) {
      const replay = await findVersionByIdempotency(tx, value.idempotencyKey);
      if (!replay) throw new ApiError(409, "计划版本捕获冲突，请重试");
      return replay;
    }

    if (lines.length > 0) {
      const storedLines: Array<{ id: number; skuId: number }> = await tx
        .insert(schema.planningVersionLines)
        .values(lines.map(({ pegging: _pegging, ...line }) => ({
          versionId: created.id,
          ...line,
        })))
        .returning({
          id: schema.planningVersionLines.id,
          skuId: schema.planningVersionLines.skuId,
        });
      const storedBySku = new Map<number, number>(
        storedLines.map((line): [number, number] => [line.skuId, line.id]),
      );
      const links = lines.flatMap((line) => {
        const planningLineId = storedBySku.get(line.skuId);
        if (planningLineId == null) throw new Error(`planning line missing after insert: ${line.skuId}`);
        return buildSupplyDemandLinks(created.id, planningLineId, line);
      });
      if (links.length > 0) await tx.insert(schema.supplyDemandLinks).values(links);
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "planning_version",
      entityId: created.id,
      action: "capture",
      after: {
        name: created.name,
        weekStart,
        lineCount: lines.length,
        suggestedCount: created.suggestedCount,
        suppressedCount: created.suppressedCount,
        digest,
        engineVersion: PLAN_ENGINE_VERSION,
      },
    });
    return toDto(created);
  });
}

export async function listPlanningVersions(
  user: SessionUser,
  dbArg?: AnyDb,
): Promise<{ versions: PlanningVersionDto[] }> {
  requireAnyRole(user, "pmc", "purchasing");
  const db = await resolveDb(dbArg);
  const rows = await db
    .select({
      id: schema.planningVersions.id,
      name: schema.planningVersions.name,
      weekStart: schema.planningVersions.weekStart,
      engineVersion: schema.planningVersions.engineVersion,
      lineCount: schema.planningVersions.lineCount,
      suggestedCount: schema.planningVersions.suggestedCount,
      suppressedCount: schema.planningVersions.suppressedCount,
      digest: schema.planningVersions.digest,
      createdBy: schema.planningVersions.createdBy,
      createdByName: schema.users.name,
      createdAt: schema.planningVersions.createdAt,
      parameters: schema.planningVersions.parameters,
      sourceMeta: schema.planningVersions.sourceMeta,
    })
    .from(schema.planningVersions)
    .leftJoin(schema.users, eq(schema.planningVersions.createdBy, schema.users.id))
    .orderBy(desc(schema.planningVersions.createdAt), desc(schema.planningVersions.id))
    .limit(MAX_VERSIONS);
  return { versions: rows.map(toDto) };
}

async function getVersion(db: AnyDb, id: number): Promise<PlanningVersionDto | null> {
  const [row] = await db
    .select({
      id: schema.planningVersions.id,
      name: schema.planningVersions.name,
      weekStart: schema.planningVersions.weekStart,
      engineVersion: schema.planningVersions.engineVersion,
      lineCount: schema.planningVersions.lineCount,
      suggestedCount: schema.planningVersions.suggestedCount,
      suppressedCount: schema.planningVersions.suppressedCount,
      digest: schema.planningVersions.digest,
      createdBy: schema.planningVersions.createdBy,
      createdByName: schema.users.name,
      createdAt: schema.planningVersions.createdAt,
      parameters: schema.planningVersions.parameters,
      sourceMeta: schema.planningVersions.sourceMeta,
    })
    .from(schema.planningVersions)
    .leftJoin(schema.users, eq(schema.planningVersions.createdBy, schema.users.id))
    .where(eq(schema.planningVersions.id, id))
    .limit(1);
  return row ? toDto(row) : null;
}

async function getVersionLines(db: AnyDb, versionId: number): Promise<PlanSnapshotLine[]> {
  return db
    .select({
      skuId: schema.planningVersionLines.skuId,
      skuCode: schema.planningVersionLines.skuCode,
      skuName: schema.planningVersionLines.skuName,
      brand: schema.planningVersionLines.brand,
      baseUom: schema.planningVersionLines.baseUom,
      suggestedQty: schema.planningVersionLines.suggestedQty,
      suppressed: schema.planningVersionLines.suppressed,
      shortageDate: schema.planningVersionLines.shortageDate,
      orderByDate: schema.planningVersionLines.orderByDate,
      orderWindowMissed: schema.planningVersionLines.orderWindowMissed,
      coverFull: schema.planningVersionLines.coverFull,
    })
    .from(schema.planningVersionLines)
    .where(eq(schema.planningVersionLines.versionId, versionId));
}

export async function comparePlanningVersions(
  user: SessionUser,
  currentId: number,
  baseId?: number,
  dbArg?: AnyDb,
): Promise<PlanningVersionDiffDto> {
  requireAnyRole(user, "pmc", "purchasing");
  if (!Number.isInteger(currentId) || currentId <= 0) throw new ApiError(400, "currentId 必须为正整数");
  if (baseId != null && (!Number.isInteger(baseId) || baseId <= 0)) throw new ApiError(400, "baseId 必须为正整数");
  if (baseId === currentId) throw new ApiError(400, "基准版本不能与当前版本相同");
  const db = await resolveDb(dbArg);
  const current = await getVersion(db, currentId);
  if (!current) throw new ApiError(404, "当前计划版本不存在");

  let base = baseId == null ? null : await getVersion(db, baseId);
  if (baseId != null && !base) throw new ApiError(404, "基准计划版本不存在");
  if (baseId == null) {
    const [previous] = await db
      .select({ id: schema.planningVersions.id })
      .from(schema.planningVersions)
      .where(lt(schema.planningVersions.id, currentId))
      .orderBy(desc(schema.planningVersions.id))
      .limit(1);
    if (previous) base = await getVersion(db, previous.id);
  }

  const [currentRows, baseRows] = await Promise.all([
    getVersionLines(db, current.id),
    base ? getVersionLines(db, base.id) : Promise.resolve([]),
  ]);
  return {
    current,
    base,
    ...diffPlanVersions(baseRows, currentRows),
  };
}

export interface PlanningPeggingQuery {
  versionId: number;
  skuId?: number;
  sourceType?: string;
  sourceRef?: string;
}

export async function getPlanningPegging(
  user: SessionUser,
  query: PlanningPeggingQuery,
  dbArg?: AnyDb,
) {
  requireAnyRole(user, "pmc", "purchasing");
  if (!Number.isInteger(query.versionId) || query.versionId <= 0) {
    throw new ApiError(400, "versionId 必须为正整数");
  }
  if (query.skuId != null && (!Number.isInteger(query.skuId) || query.skuId <= 0)) {
    throw new ApiError(400, "skuId 必须为正整数");
  }
  if ((query.sourceType == null) !== (query.sourceRef == null)) {
    throw new ApiError(400, "供给反查必须同时提供 sourceType 与 sourceRef");
  }
  const db = await resolveDb(dbArg);
  const version = await getVersion(db, query.versionId);
  if (!version) throw new ApiError(404, "计划版本不存在");

  const conditions = [eq(schema.supplyDemandLinks.versionId, query.versionId)];
  if (query.skuId != null) conditions.push(eq(schema.supplyDemandLinks.skuId, query.skuId));
  if (query.sourceType != null && query.sourceRef != null) {
    conditions.push(eq(schema.supplyDemandLinks.sourceType, query.sourceType));
    conditions.push(eq(schema.supplyDemandLinks.sourceRef, query.sourceRef));
  }
  const rows = await db
    .select({
      id: schema.supplyDemandLinks.id,
      planningLineId: schema.supplyDemandLinks.planningLineId,
      skuId: schema.supplyDemandLinks.skuId,
      skuCode: schema.planningVersionLines.skuCode,
      skuName: schema.planningVersionLines.skuName,
      baseUom: schema.planningVersionLines.baseUom,
      evidenceDigest: schema.planningVersionLines.evidenceDigest,
      demandType: schema.supplyDemandLinks.demandType,
      demandDate: schema.supplyDemandLinks.demandDate,
      demandQty: schema.supplyDemandLinks.demandQty,
      sourceType: schema.supplyDemandLinks.sourceType,
      sourceRef: schema.supplyDemandLinks.sourceRef,
      sourceDocId: schema.supplyDemandLinks.sourceDocId,
      sourceLineId: schema.supplyDemandLinks.sourceLineId,
      supplyDate: schema.supplyDemandLinks.supplyDate,
      availableQty: schema.supplyDemandLinks.availableQty,
      peggedQty: schema.supplyDemandLinks.peggedQty,
      confidence: schema.supplyDemandLinks.confidence,
      status: schema.supplyDemandLinks.status,
      sequence: schema.supplyDemandLinks.sequence,
      explanation: schema.supplyDemandLinks.explanation,
    })
    .from(schema.supplyDemandLinks)
    .innerJoin(
      schema.planningVersionLines,
      eq(schema.supplyDemandLinks.planningLineId, schema.planningVersionLines.id),
    )
    .where(and(...conditions))
    .orderBy(
      asc(schema.supplyDemandLinks.planningLineId),
      asc(schema.supplyDemandLinks.sequence),
    );

  let summaryRows: Array<{
    planningLineId: number;
    demandQty: string;
    peggedQty: string;
    confidence: string;
  }> = rows;
  if (query.sourceRef != null && rows.length > 0) {
    const planningLineIds = [...new Set<number>(
      rows.map((row: { planningLineId: number }) => row.planningLineId),
    )];
    summaryRows = await db
      .select({
        planningLineId: schema.supplyDemandLinks.planningLineId,
        demandQty: schema.supplyDemandLinks.demandQty,
        peggedQty: schema.supplyDemandLinks.peggedQty,
        confidence: schema.supplyDemandLinks.confidence,
      })
      .from(schema.supplyDemandLinks)
      .where(and(
        eq(schema.supplyDemandLinks.versionId, query.versionId),
        inArray(schema.supplyDemandLinks.planningLineId, planningLineIds),
      ));
  }

  const demandByLine = new Map<number, string>();
  let peggedQty = "0";
  let bookedQty = "0";
  let referenceQty = "0";
  let proposedQty = "0";
  for (const row of summaryRows) {
    demandByLine.set(row.planningLineId, row.demandQty);
    peggedQty = dAdd(peggedQty, row.peggedQty, 4);
    if (row.confidence === "booked") bookedQty = dAdd(bookedQty, row.peggedQty, 4);
    if (row.confidence === "reference") referenceQty = dAdd(referenceQty, row.peggedQty, 4);
    if (row.confidence === "proposed") proposedQty = dAdd(proposedQty, row.peggedQty, 4);
  }
  let demandQty = "0";
  for (const value of demandByLine.values()) demandQty = dAdd(demandQty, value, 4);
  const coveragePct = dCmp(demandQty, "0") > 0
    ? Math.min(100, Math.round((Number(peggedQty) / Number(demandQty)) * 1000) / 10)
    : 0;

  return {
    version,
    mode: query.sourceRef == null ? "demand_to_supply" : "supply_to_demand",
    query: {
      skuId: query.skuId ?? null,
      sourceType: query.sourceType ?? null,
      sourceRef: query.sourceRef ?? null,
    },
    summary: {
      demandQty,
      peggedQty,
      bookedQty,
      referenceQty,
      proposedQty,
      uncoveredQty: dCmp(demandQty, peggedQty) > 0 ? dSub(demandQty, peggedQty, 4) : "0.0000",
      coveragePct,
      demandCount: demandByLine.size,
      linkCount: rows.length,
    },
    rows,
  };
}
