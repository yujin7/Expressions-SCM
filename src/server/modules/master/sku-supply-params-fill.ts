/**
 * 周期主数据补录（IAL-06 / FS-R6 / R8）：加工周期 / 采购周期 / 在途周期 逐 SKU 填补，
 * 与分层（sku_planning_policy 最近期）并排——S/A/B 缺任一周期即阻塞（直出/试点/预警阈值全都要它）。
 *
 * 读：master/sku-supply-params.getSkuSupplyParams 唯一 facade（MOQ 已换算基础单位）+ sku_params.purchase_lead_days
 *     （facade 尚未暴露该列，此处补读，不改 facade——另一域文件）。
 * 写：PATCH 只允许**填空**（原值为 null）；覆盖非空值须 pmc（admin 兜底）；purchasing 只能填空。
 *     同事务 upsert sku_params + writeAudit(entity=sku_params, action=fill|override)。
 * 语义：成品 normal=加工、logistics=在途；部件（raw/packaging/semi）purchase=采购周期。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { getSkuSupplyParams } from "@/server/modules/master/sku-supply-params";
import { latestPolicyPeriod, loadPolicyMap } from "@/server/modules/planning/policy";
import { requireAnyRole } from "@/server/modules/outsource/common";
import type { Tier } from "@/server/rules/abc";

export const SUPPLY_PARAM_MISSING_DIMS = ["production", "logistics", "purchase", "moq", "cost", "any"] as const;
export type SupplyParamMissingDim = (typeof SUPPLY_PARAM_MISSING_DIMS)[number];
export const SUPPLY_PARAM_DIM_LABELS: Record<Exclude<SupplyParamMissingDim, "any">, string> = {
  production: "加工周期",
  logistics: "在途周期",
  purchase: "采购周期",
  moq: "MOQ",
  cost: "成本",
};

export interface SupplyParamRow {
  skuId: number;
  code: string;
  name: string;
  skuType: string;
  brand: string | null;
  /** 最近固化期生效分层；未固化/非成品 = null */
  tier: Tier | null;
  normalLeadDays: number | null;
  logisticsLeadDays: number | null;
  purchaseLeadDays: number | null;
  moq: string | null;
  hasCost: boolean;
  /** 适用且缺失的维度（成品：production/logistics；部件：purchase；moq/cost 全类型） */
  missing: Exclude<SupplyParamMissingDim, "any">[];
  /** S/A/B 缺加工或在途周期 → 阻塞直出/试点/预警阈值 */
  blocked: boolean;
}

export interface SupplyParamListResult {
  rows: SupplyParamRow[];
  total: number;
  policyPeriod: string | null;
  summary: {
    scanned: number;
    complete: number;
    byDimension: Record<Exclude<SupplyParamMissingDim, "any">, number>;
    /** S/A/B 缺周期的成品数（分层阻塞） */
    blocked: number;
    byTier: Record<Tier | "unclassified", { total: number; complete: number; blocked: number }>;
  };
}

export interface SupplyParamQuery {
  q?: string;
  skuType?: string;
  missing?: string;
  tier?: string;
  blockedOnly?: boolean;
  page?: number;
  pageSize?: number;
}

const APPLICABLE_TYPES = ["finished", "semi", "raw", "packaging"] as const;

export async function listSupplyParams(query: SupplyParamQuery, dbArg?: AnyDb): Promise<SupplyParamListResult> {
  const db = await resolveDb(dbArg);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();
  const typeFilter = (query.skuType ?? "").trim();
  const missingFilter = (query.missing ?? "").trim() as SupplyParamMissingDim | "";
  const tierFilter = (query.tier ?? "").trim().toUpperCase();

  const skuRows: { id: number; code: string; name: string; skuType: string; brand: string | null }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, skuType: schema.skus.skuType, brand: schema.brands.nameCn })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(and(eq(schema.skus.active, true), inArray(schema.skus.skuType, [...APPLICABLE_TYPES])));
  const policyPeriod = await latestPolicyPeriod(db);
  const byDimension: SupplyParamListResult["summary"]["byDimension"] = { production: 0, logistics: 0, purchase: 0, moq: 0, cost: 0 };
  const byTier: SupplyParamListResult["summary"]["byTier"] = {
    S: { total: 0, complete: 0, blocked: 0 }, A: { total: 0, complete: 0, blocked: 0 }, B: { total: 0, complete: 0, blocked: 0 },
    C: { total: 0, complete: 0, blocked: 0 }, unclassified: { total: 0, complete: 0, blocked: 0 },
  };
  if (skuRows.length === 0) {
    return { rows: [], total: 0, policyPeriod, summary: { scanned: 0, complete: 0, byDimension, blocked: 0, byTier } };
  }
  const skuIds = skuRows.map((s) => s.id);
  const [params, purchaseRows, policy] = await Promise.all([
    getSkuSupplyParams(skuIds, db),
    db.select({ skuId: schema.skuParams.skuId, purchaseLeadDays: schema.skuParams.purchaseLeadDays }).from(schema.skuParams).where(inArray(schema.skuParams.skuId, skuIds)) as Promise<{ skuId: number; purchaseLeadDays: number | null }[]>,
    loadPolicyMap(db, policyPeriod),
  ]);
  const purchaseBySku = new Map(purchaseRows.map((r) => [r.skuId, r.purchaseLeadDays]));

  const all: SupplyParamRow[] = skuRows.map((s) => {
    const p = params.get(s.id);
    const isFinished = s.skuType === "finished";
    const pol = policy.bySku.get(s.id);
    const tier = isFinished ? (pol?.effectiveTier ?? null) : null;
    const normalLeadDays = p?.normalLeadDays ?? null;
    const logisticsLeadDays = p?.logisticsLeadDays ?? null;
    const purchaseLeadDays = purchaseBySku.get(s.id) ?? null;
    const missing: SupplyParamRow["missing"] = [];
    if (isFinished) {
      if (!(normalLeadDays != null && normalLeadDays > 0)) missing.push("production");
      if (logisticsLeadDays == null) missing.push("logistics");
    } else if (!(purchaseLeadDays != null && purchaseLeadDays > 0)) missing.push("purchase");
    if (p?.moq == null) missing.push("moq");
    if (p?.unitCost == null) missing.push("cost");
    const blocked = isFinished && tier != null && tier !== "C" && (missing.includes("production") || missing.includes("logistics"));
    return { skuId: s.id, code: s.code, name: s.name, skuType: s.skuType, brand: s.brand, tier, normalLeadDays, logisticsLeadDays, purchaseLeadDays, moq: p?.moq ?? null, hasCost: p?.unitCost != null, missing, blocked };
  });

  let complete = 0;
  let blocked = 0;
  for (const r of all) {
    for (const m of r.missing) byDimension[m] += 1;
    if (r.missing.length === 0) complete += 1;
    if (r.blocked) blocked += 1;
    if (r.skuType === "finished") {
      const k = r.tier ?? "unclassified";
      byTier[k].total += 1;
      if (!r.missing.includes("production") && !r.missing.includes("logistics")) byTier[k].complete += 1;
      if (r.blocked) byTier[k].blocked += 1;
    }
  }

  let filtered = all;
  if (typeFilter) filtered = filtered.filter((r) => r.skuType === typeFilter);
  if (missingFilter === "any") filtered = filtered.filter((r) => r.missing.length > 0);
  else if (missingFilter) filtered = filtered.filter((r) => r.missing.includes(missingFilter));
  if (tierFilter === "NONE") filtered = filtered.filter((r) => r.skuType === "finished" && r.tier == null);
  else if (tierFilter) filtered = filtered.filter((r) => r.tier === tierFilter);
  if (query.blockedOnly) filtered = filtered.filter((r) => r.blocked);
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const order: Record<string, number> = { S: 0, A: 1, B: 2, C: 3 };
  filtered.sort((a, b) => Number(b.blocked) - Number(a.blocked) || (order[a.tier ?? ""] ?? 4) - (order[b.tier ?? ""] ?? 4) || b.missing.length - a.missing.length || a.code.localeCompare(b.code));
  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    policyPeriod,
    summary: { scanned: all.length, complete, byDimension, blocked, byTier },
  };
}

/* ────────────────────────── 写路径 ────────────────────────── */

const days = z.number().int().min(0).max(365).nullable();
const patchSchema = z.object({
  normalLeadDays: days.optional(),
  logisticsLeadDays: days.optional(),
  purchaseLeadDays: days.optional(),
  note: z.string().trim().max(200).optional(),
}).refine((v) => v.normalLeadDays !== undefined || v.logisticsLeadDays !== undefined || v.purchaseLeadDays !== undefined, "至少提供一个周期字段");
export type PatchSupplyParamsInput = z.infer<typeof patchSchema>;

type LeadField = "normalLeadDays" | "logisticsLeadDays" | "purchaseLeadDays";
const FIELD_LABELS: Record<LeadField, string> = { normalLeadDays: "加工周期", logisticsLeadDays: "在途周期", purchaseLeadDays: "采购周期" };

export async function patchSupplyParams(
  user: SessionUser,
  skuId: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ skuId: number; normalLeadDays: number | null; logisticsLeadDays: number | null; purchaseLeadDays: number | null; action: "fill" | "override" }> {
  requireAnyRole(user, "pmc", "purchasing");
  const v = patchSchema.parse(input);
  const canOverride = user.roles.includes("admin") || user.roles.includes("pmc");
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [sku] = await tx.select({ id: schema.skus.id, code: schema.skus.code }).from(schema.skus).where(eq(schema.skus.id, skuId));
    if (!sku) throw new ApiError(404, "SKU 不存在");
    const [existing] = await tx.select().from(schema.skuParams).where(eq(schema.skuParams.skuId, skuId));
    const before = {
      normalLeadDays: existing?.normalLeadDays ?? null,
      logisticsLeadDays: existing?.logisticsLeadDays ?? null,
      purchaseLeadDays: existing?.purchaseLeadDays ?? null,
    };
    const set: Partial<Record<LeadField, number | null>> = {};
    let isOverride = false;
    for (const f of ["normalLeadDays", "logisticsLeadDays", "purchaseLeadDays"] as const) {
      const next = v[f];
      if (next === undefined) continue;
      const prev = before[f];
      if (prev === next) continue;
      if (prev != null) {
        if (!canOverride) throw new ApiError(403, `「${FIELD_LABELS[f]}」已有值 ${prev}，只有生产计划（pmc）或管理员可覆盖；采购只能补录空值`);
        isOverride = true;
      }
      set[f] = next;
    }
    if (Object.keys(set).length === 0) {
      return { skuId, ...before, action: "fill" };
    }
    await tx
      .insert(schema.skuParams)
      .values({ skuId, ...set, updatedBy: user.id, updatedAt: sql`now()` })
      .onConflictDoUpdate({ target: schema.skuParams.skuId, set: { ...set, updatedBy: user.id, updatedAt: sql`now()` } });
    const after = { ...before, ...set };
    await writeAudit(tx, {
      userId: user.id,
      entity: "sku_params",
      entityId: skuId,
      action: isOverride ? "override" : "fill",
      before: { skuCode: sku.code, ...before },
      after: { skuCode: sku.code, ...after, note: v.note ?? null },
    });
    return { skuId, ...after, action: isOverride ? "override" : "fill" };
  });
}
