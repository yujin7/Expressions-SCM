import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";

import {
  getSkuProjection,
  type ProjectionScenario,
  type SkuProjection,
} from "./projection";

const MAX_SCENARIOS_PER_SKU = 20;

export const saveProjectionScenarioSchema = z.object({
  sku: z.union([z.string().trim().min(1).max(80), z.number().int().positive()]),
  name: z.string().trim().min(1, "请输入情景名称").max(80),
  horizonDays: z.number().int().min(14).max(365).default(120),
  extraInboundQty: z.number().finite().positive().optional(),
  extraInboundDate: z.string().date().optional(),
  dailyOverride: z.number().finite().nonnegative().optional(),
  idempotencyKey: z.string().uuid(),
}).superRefine((value, ctx) => {
  const hasQty = value.extraInboundQty != null;
  const hasDate = value.extraInboundDate != null;
  if (hasQty !== hasDate) {
    ctx.addIssue({
      code: "custom",
      path: hasQty ? ["extraInboundDate"] : ["extraInboundQty"],
      message: "假设到货量与到货日必须同时填写",
    });
  }
  if (!hasQty && value.dailyOverride == null) {
    ctx.addIssue({ code: "custom", path: ["dailyOverride"], message: "至少填写一个推演变量" });
  }
});

type SavedProjection = SkuProjection & { scenarioApplied: boolean };

export interface ProjectionScenarioDto {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  name: string;
  horizonDays: number;
  inputs: ProjectionScenario;
  baseline: SavedProjection;
  scenario: SavedProjection;
  sourceDate: string;
  createdBy: number;
  createdByName: string | null;
  createdAt: string;
}

function dto(row: {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  name: string;
  horizonDays: number;
  inputs: unknown;
  baselineResult: unknown;
  scenarioResult: unknown;
  sourceDate: string;
  createdBy: number;
  createdByName: string | null;
  createdAt: Date | string;
}): ProjectionScenarioDto {
  return {
    id: row.id,
    skuId: row.skuId,
    skuCode: row.skuCode,
    skuName: row.skuName,
    name: row.name,
    horizonDays: row.horizonDays,
    inputs: row.inputs as ProjectionScenario,
    baseline: row.baselineResult as SavedProjection,
    scenario: row.scenarioResult as SavedProjection,
    sourceDate: row.sourceDate,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

const scenarioSelect = {
  id: schema.projectionScenarios.id,
  skuId: schema.projectionScenarios.skuId,
  skuCode: schema.skus.code,
  skuName: schema.skus.name,
  name: schema.projectionScenarios.name,
  horizonDays: schema.projectionScenarios.horizonDays,
  inputs: schema.projectionScenarios.inputs,
  baselineResult: schema.projectionScenarios.baselineResult,
  scenarioResult: schema.projectionScenarios.scenarioResult,
  sourceDate: schema.projectionScenarios.sourceDate,
  createdBy: schema.projectionScenarios.createdBy,
  createdByName: schema.users.name,
  createdAt: schema.projectionScenarios.createdAt,
};

async function findByIdempotency(
  db: AnyDb,
  idempotencyKey: string,
): Promise<ProjectionScenarioDto | null> {
  const [row] = await db
    .select(scenarioSelect)
    .from(schema.projectionScenarios)
    .innerJoin(schema.skus, eq(schema.skus.id, schema.projectionScenarios.skuId))
    .leftJoin(schema.users, eq(schema.users.id, schema.projectionScenarios.createdBy))
    .where(eq(schema.projectionScenarios.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ? dto(row) : null;
}

export async function listProjectionScenarios(
  skuCodeOrId: string | number,
  dbArg?: AnyDb,
): Promise<ProjectionScenarioDto[]> {
  const db = await resolveDb(dbArg);
  const skuWhere = typeof skuCodeOrId === "number"
    ? eq(schema.skus.id, skuCodeOrId)
    : eq(schema.skus.code, String(skuCodeOrId).trim());
  const [sku] = await db.select({ id: schema.skus.id }).from(schema.skus).where(skuWhere).limit(1);
  if (!sku) throw new ApiError(404, "SKU 不存在");
  const rows = await db
    .select(scenarioSelect)
    .from(schema.projectionScenarios)
    .innerJoin(schema.skus, eq(schema.skus.id, schema.projectionScenarios.skuId))
    .leftJoin(schema.users, eq(schema.users.id, schema.projectionScenarios.createdBy))
    .where(eq(schema.projectionScenarios.skuId, sku.id))
    .orderBy(desc(schema.projectionScenarios.createdAt))
    .limit(MAX_SCENARIOS_PER_SKU);
  return rows.map(dto);
}

export async function saveProjectionScenario(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<ProjectionScenarioDto> {
  requireAnyRole(user, "pmc");
  const value = saveProjectionScenarioSchema.parse(input);
  const db = await resolveDb(dbArg);
  const existing = await findByIdempotency(db, value.idempotencyKey);
  if (existing) {
    const sameSku = typeof value.sku === "number"
      ? existing.skuId === value.sku
      : existing.skuCode === value.sku;
    if (sameSku) return existing;
    throw new ApiError(409, "幂等键已用于其他 SKU");
  }

  const scenario: ProjectionScenario = {
    extraInboundQty: value.extraInboundQty,
    extraInboundDate: value.extraInboundDate,
    dailyOverride: value.dailyOverride,
  };
  const [baseline, projected] = await Promise.all([
    getSkuProjection(value.sku, value.horizonDays, db),
    getSkuProjection(value.sku, value.horizonDays, db, scenario),
  ]);
  if (!projected.scenarioApplied) throw new ApiError(400, "推演变量没有改变基准情景");

  return db.transaction(async (tx: AnyDb) => {
    const [created] = await tx
      .insert(schema.projectionScenarios)
      .values({
        skuId: projected.skuId,
        name: value.name,
        horizonDays: value.horizonDays,
        inputs: scenario,
        baselineResult: baseline,
        scenarioResult: projected,
        sourceDate: projected.today,
        idempotencyKey: value.idempotencyKey,
        createdBy: user.id,
      })
      .onConflictDoNothing({ target: schema.projectionScenarios.idempotencyKey })
      .returning({ id: schema.projectionScenarios.id });
    if (!created) {
      const replay = await findByIdempotency(tx, value.idempotencyKey);
      if (replay && replay.skuId === projected.skuId) return replay;
      throw new ApiError(409, "幂等键已用于其他 SKU");
    }
    await writeAudit(tx, {
      userId: user.id,
      action: "create",
      entity: "projection_scenario",
      entityId: created.id,
      after: {
        skuId: projected.skuId,
        name: value.name,
        horizonDays: value.horizonDays,
        inputs: scenario,
        sourceDate: projected.today,
      },
    });
    const saved = await findByIdempotency(tx, value.idempotencyKey);
    if (!saved) throw new ApiError(500, "情景保存后读取失败");
    return saved;
  });
}
