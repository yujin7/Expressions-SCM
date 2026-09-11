/**
 * 周期主数据**批量**补录（2026-09-04 审计 #1）——167 个补货试点候选的唯一解锁点。
 *
 * 为什么必须有批量：生产库 5,376 个在用 SKU 只有 520 个有周期参数；
 * 补货试点的 167 个候选**只**卡在这一件事上。今天只有逐行 PATCH
 * （`PATCH /api/master/sku/{id}/supply-params`），补 5,000 行要点五千次——等于这条路不存在。
 *
 * 边界与逐行 PATCH 完全一致（同一套 `leadFieldsFor` / 填空 vs 覆盖 / 角色判定），
 * 只是把「一次一行」换成「一次一批」：
 *  - 只写该 SKU 类型适用的字段；不适用的字段**跳过该 SKU**而不是整批失败
 *    （批量选择天然混着成品与原料，整批失败等于逼人重新逐个挑）；
 *  - `overwrite=false`（缺省）只填空值；覆盖非空值须 pmc/admin，采购只能填空；
 *  - `dryRun` 出预演口径：会填多少、会覆盖多少、多少行本来就一样、多少行不适用——
 *    「按分层/品牌套用默认」必须先让人看见会动多少行，再让人点确认；
 *  - 单次上限 `BULK_MAX_SKUS`，超出要求先收窄筛选（宁可分批，也不做一个跑十分钟的事务）；
 *  - 逐 SKU 落审计（与逐行 PATCH 同 entity/entityId/action，另标 `bulk:true`），
 *    否则「谁把这 300 个 SKU 的加工周期设成 30 天」在审计里查不出来。
 *
 * 目标集合与页面清单**共用 `listSupplyParams`**：否则「预览说 167 行」和
 * 「页面上看到 167 行」会各算各的，业务永远不知道自己批量改了哪些。
 */
import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { leadFieldsFor, listSupplyParams, type LeadField } from "@/server/modules/master/sku-supply-params-fill";

/** 单次批量上限：够覆盖一个分层/品牌的整批，又不至于把事务拖成分钟级 */
export const BULK_MAX_SKUS = 500;

const bulkDays = z.number().int().min(0).max(365);

const bulkSchema = z.object({
  scope: z.union([
    z.object({ kind: z.literal("ids"), ids: z.array(z.number().int().positive()).min(1).max(BULK_MAX_SKUS) }),
    z.object({
      kind: z.literal("filter"),
      tier: z.string().trim().max(20).optional(),
      brandId: z.number().int().positive().optional(),
      skuType: z.string().trim().max(20).optional(),
      blockedOnly: z.boolean().optional(),
      q: z.string().trim().max(200).optional(),
      missing: z.enum(["", "any", "production", "logistics", "purchase", "moq", "cost"]).optional(),
      /** 只对「还缺周期」的行套用（缺省 true：套默认值不该顺手改掉人工填过的数） */
      onlyMissing: z.boolean().optional(),
    }),
  ]),
  values: z
    .object({
      normalLeadDays: bulkDays.optional(),
      logisticsLeadDays: bulkDays.optional(),
      purchaseLeadDays: bulkDays.optional(),
    })
    .refine(
      (v) => v.normalLeadDays !== undefined || v.logisticsLeadDays !== undefined || v.purchaseLeadDays !== undefined,
      "至少提供一个周期字段",
    ),
  overwrite: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  expectedPreview: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  note: z.string().trim().max(200).optional(),
});

export type BulkSupplyParamsInput = z.infer<typeof bulkSchema>;

export interface BulkSupplyParamsResult {
  /** Exact reviewed scope, values and current facts; not authorization. */
  previewKey: string;
  dryRun: boolean;
  /** 落在作用域内的 SKU 数 */
  matched: number;
  /** 空值被补上的字段数 */
  filled: number;
  /** 非空值被覆盖的字段数 */
  overridden: number;
  /** 实际写入（或将写入）的 SKU 数 */
  changedSkus: number;
  /** 值与现状相同、无需写入的 SKU 数 */
  unchangedSkus: number;
  /** 因类型不适用而跳过的 SKU 数（如给原料填「加工周期」） */
  notApplicableSkus: number;
  /** 预演给人看的前若干个 SKU 编码 */
  sampleCodes: string[];
}

interface BulkTargetRow {
  skuId: number;
  code: string;
  skuType: string;
  normalLeadDays: number | null;
  logisticsLeadDays: number | null;
  purchaseLeadDays: number | null;
}

async function loadBulkTargets(db: AnyDb, scope: BulkSupplyParamsInput["scope"]): Promise<BulkTargetRow[]> {
  if (scope.kind === "filter") {
    const list = await listSupplyParams(
      {
        tier: scope.tier,
        brandId: scope.brandId,
        skuType: scope.skuType,
        blockedOnly: scope.blockedOnly,
        q: scope.q,
        missing: scope.missing,
        page: 1,
        pageSize: BULK_MAX_SKUS,
      },
      db,
    );
    if (list.total > BULK_MAX_SKUS) {
      throw new ApiError(
        400,
        `当前条件命中 ${list.total} 个 SKU，超过单次上限 ${BULK_MAX_SKUS}；请先按分层/品牌/类型收窄再套用`,
      );
    }
    const rows = scope.onlyMissing === false ? list.rows : list.rows.filter((r) => r.missing.length > 0);
    return rows.map((r) => ({
      skuId: r.skuId,
      code: r.code,
      skuType: r.skuType,
      normalLeadDays: r.normalLeadDays,
      logisticsLeadDays: r.logisticsLeadDays,
      purchaseLeadDays: r.purchaseLeadDays,
    }));
  }

  const ids = [...new Set(scope.ids)];
  const skuRows: { id: number; code: string; skuType: string }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, skuType: schema.skus.skuType })
    .from(schema.skus)
    .where(inArray(schema.skus.id, ids))
    // 确定性顺序：避免并发批次交叉时的行锁死锁（同 master/sku.setSkuCommercialRoles）
    .orderBy(schema.skus.id);
  if (skuRows.length !== ids.length) {
    const found = new Set(skuRows.map((r) => r.id));
    const absent = ids.filter((id) => !found.has(id));
    throw new ApiError(404, `以下 SKU 不存在，整批未改：${absent.slice(0, 10).join("、")}`);
  }
  const paramRows: {
    skuId: number;
    normalLeadDays: number | null;
    logisticsLeadDays: number | null;
    purchaseLeadDays: number | null;
  }[] = await db
    .select({
      skuId: schema.skuParams.skuId,
      normalLeadDays: schema.skuParams.normalLeadDays,
      logisticsLeadDays: schema.skuParams.logisticsLeadDays,
      purchaseLeadDays: schema.skuParams.purchaseLeadDays,
    })
    .from(schema.skuParams)
    .where(inArray(schema.skuParams.skuId, ids));
  const byId = new Map(paramRows.map((r) => [r.skuId, r]));
  return skuRows.map((s) => {
    const p = byId.get(s.id);
    return {
      skuId: s.id,
      code: s.code,
      skuType: s.skuType,
      normalLeadDays: p?.normalLeadDays ?? null,
      logisticsLeadDays: p?.logisticsLeadDays ?? null,
      purchaseLeadDays: p?.purchaseLeadDays ?? null,
    };
  });
}

export async function bulkFillSupplyParams(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<BulkSupplyParamsResult> {
  requireAnyRole(user, "pmc", "purchasing");
  const v = bulkSchema.parse(input);
  const canOverride = user.roles.includes("admin") || user.roles.includes("pmc");
  if (v.overwrite && !canOverride) {
    throw new ApiError(403, "覆盖已有周期须生产计划（pmc）或管理员；采购只能补录空值");
  }
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
  const selected = await loadBulkTargets(tx, v.scope);
  if (!v.dryRun && selected.length) {
    await tx.select({ id: schema.skus.id }).from(schema.skus)
      .where(inArray(schema.skus.id, selected.map(r => r.skuId))).orderBy(schema.skus.id).for("update");
    await tx.select({ id: schema.skuParams.skuId }).from(schema.skuParams)
      .where(inArray(schema.skuParams.skuId, selected.map(r => r.skuId))).orderBy(schema.skuParams.skuId).for("update");
  }
  // Re-read after the lock: a queued fill must not overwrite a concurrent fill.
  const targets = selected.length && !v.dryRun
    ? await loadBulkTargets(tx, { kind: "ids", ids: selected.map(r => r.skuId) }) : selected;
  targets.sort((a, b) => a.skuId - b.skuId);
  const previewKey = createHash("sha256").update(JSON.stringify({
    actor: user.id, overwrite: v.overwrite === true, values: v.values, targets,
  })).digest("hex");
  if (!v.dryRun && v.expectedPreview && v.expectedPreview !== previewKey) {
    throw new ApiError(409, "预演后目标或周期已变化，整批未写入；请重新预演并核对");
  }

  const plans: {
    row: BulkTargetRow;
    set: Partial<Record<LeadField, number>>;
    before: Record<LeadField, number | null>;
    isOverride: boolean;
  }[] = [];
  let filled = 0;
  let overridden = 0;
  let notApplicableSkus = 0;
  let unchangedSkus = 0;

  for (const row of targets) {
    const applicable = leadFieldsFor(row.skuType);
    const before = {
      normalLeadDays: row.normalLeadDays,
      logisticsLeadDays: row.logisticsLeadDays,
      purchaseLeadDays: row.purchaseLeadDays,
    };
    const set: Partial<Record<LeadField, number>> = {};
    let isOverride = false;
    let sawInapplicable = false;
    for (const f of ["normalLeadDays", "logisticsLeadDays", "purchaseLeadDays"] as const) {
      const next = v.values[f];
      if (next === undefined) continue;
      if (!applicable.includes(f)) {
        sawInapplicable = true;
        continue;
      }
      const prev = before[f];
      if (prev === next) continue;
      if (prev != null) {
        if (!v.overwrite) continue; // 缺省只填空：已有值原样保留（与逐行 PATCH 同规则）
        isOverride = true;
        overridden += 1;
      } else {
        filled += 1;
      }
      set[f] = next;
    }
    if (Object.keys(set).length === 0) {
      if (sawInapplicable) notApplicableSkus += 1;
      else unchangedSkus += 1;
      continue;
    }
    plans.push({ row, set, before, isOverride });
  }

  const result: BulkSupplyParamsResult = {
    previewKey,
    dryRun: v.dryRun === true,
    matched: targets.length,
    filled,
    overridden,
    changedSkus: plans.length,
    unchangedSkus,
    notApplicableSkus,
    sampleCodes: plans.slice(0, 10).map((p) => p.row.code),
  };
  if (v.dryRun || plans.length === 0) return result;

    for (const plan of plans) {
      await tx
        .insert(schema.skuParams)
        .values({ skuId: plan.row.skuId, ...plan.set, updatedBy: user.id, updatedAt: sql`now()` })
        .onConflictDoUpdate({
          target: schema.skuParams.skuId,
          set: { ...plan.set, updatedBy: user.id, updatedAt: sql`now()` },
        });
      await writeAudit(tx, {
        userId: user.id,
        entity: "sku_params",
        entityId: plan.row.skuId,
        action: plan.isOverride ? "override" : "fill",
        before: { skuCode: plan.row.code, ...plan.before },
        after: { skuCode: plan.row.code, ...plan.before, ...plan.set, note: v.note ?? null, bulk: true },
      });
    }
  return result;
  });
}
