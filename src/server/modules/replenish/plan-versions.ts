import { createHash } from "node:crypto";

import { desc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
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

function snapshotLine(row: Awaited<ReturnType<typeof getReplenishSuggestions>>["rows"][number]) {
  const quantity = row.suggestQty ?? row.heldQty;
  if (quantity == null) return null;
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
    onHand: String(row.onHand),
    inTransit: String(row.inTransit),
    daily: String(row.daily),
    safetyQty: String(row.safetyQty),
    leadDays: row.leadDays,
    explanation: row.planExplain,
  };
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
    const lines = suggestions.rows
      .map(snapshotLine)
      .filter((line): line is NonNullable<typeof line> => line != null)
      .sort((a, b) => a.skuId - b.skuId);
    const today = todayShanghai();
    const weekStart = weekStartOf(today);
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
    };
    const digest = createHash("sha256")
      .update(JSON.stringify({ engineVersion: PLAN_ENGINE_VERSION, parameters, sourceMeta, lines }))
      .digest("hex");
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
      await tx.insert(schema.planningVersionLines).values(lines.map((line) => ({
        versionId: created.id,
        ...line,
      })));
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
