/**
 * 把一个天猫平台 SKU 认领到系统 SKU。
 *
 * 这是外部身份的第二条桥：简道云「SKU 对照表」只覆盖了 859/2,076 个平台 SKU，
 * 剩下的（按金额 44%）永远进不了对照表驱动的认领队列。这里允许业务直接把
 * 「店铺 + 平台 SKU ID」登记为 sku_identifiers(kind=external, scope=JIANDAOYUN:TMALL)，
 * 外部需求信号与身份缺口读模型会立即把它视为已映射。
 *
 * 纪律与 alias 认领完全一致：写守卫回查 DB、同一事务内登记 + 审计、重复认领幂等、
 * 同一平台 SKU 已属于另一个系统 SKU 时保持冲突（409）而不是抢占；建议候选只是建议，
 * 这里从不读取候选分数，落什么以人工传入的 skuId 为准。
 */
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";

import { getDbAsync } from "@/db";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { ensureExternalSkuIdentifierInTransaction } from "@/server/modules/master/sku-identifier";
import { refreshPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { refreshJiandaoyunExternalDemandReadModel } from "@/server/modules/report/external-demand-signal";
import { refreshExternalVelocity } from "@/server/modules/report/external-velocity";
import type { AnyDb } from "@/server/core/svc";

export const PLATFORM_SCOPES = {
  tmall: "JIANDAOYUN:TMALL",
  // 拼多多没有 SKU 级销量表，订单按 (店铺, 商品ID, 商家编码-规格) 归属，platformSkuId 传 `${商品ID}|${商家编码}`
  pdd: "JIANDAOYUN:PDD",
} as const;
export type PlatformKey = keyof typeof PLATFORM_SCOPES;

const claimCommonShape = {
  shopName: z.string().trim().min(1, "店铺名必填").max(60).refine((value) => !value.includes("|"), "店铺名不能包含 |分隔符"),
  skuId: z.number().int().positive(),
};
const tmallPlatformSkuId = z.string().trim().min(1, "平台 SKU ID 必填").max(60)
  .regex(/^[A-Za-z0-9_.-]+$/, "天猫平台 SKU ID 只能包含字母、数字、点、横线或下划线，不能包含 | 分隔符");
const pddPlatformSkuId = z.string().trim().min(1, "拼多多商品 ID 与商家编码必填").max(60)
  .regex(/^[A-Za-z0-9_.-]+\|[A-Za-z0-9_.-]+$/, "拼多多平台 SKU ID 必须是 商品ID|商家编码 的完整二元组");

const platformSkuClaimItemSchema = z.union([
  z.object({ ...claimCommonShape, platform: z.literal("pdd"), platformSkuId: pddPlatformSkuId }),
  z.object({ ...claimCommonShape, platform: z.literal("tmall").default("tmall"), platformSkuId: tmallPlatformSkuId }),
]);

export const platformSkuClaimSchema = z.union([
  z.object({ ...claimCommonShape, platform: z.literal("pdd"), platformSkuId: pddPlatformSkuId, note: z.string().trim().max(200).optional() }),
  z.object({ ...claimCommonShape, platform: z.literal("tmall").default("tmall"), platformSkuId: tmallPlatformSkuId, note: z.string().trim().max(200).optional() }),
]);
export type PlatformSkuClaimInput = z.infer<typeof platformSkuClaimSchema>;

export function platformSkuIdentifierValue(shopName: string, platformSkuId: string): string {
  const value = `${shopName.trim()}|${platformSkuId.trim()}`;
  if (value.length > 100) throw new ApiError(400, "店铺名 + 平台 SKU ID 超过标识长度上限");
  return value;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

async function assertClaimIsConsistent(
  tx: AnyDb,
  input: Pick<PlatformSkuClaimInput, "shopName" | "platformSkuId" | "skuId" | "platform">,
) {
  const skuResult = await tx.execute(sql`
    SELECT id, code, sku_type, active FROM skus WHERE id = ${input.skuId} FOR UPDATE
  ` as SQL);
  const [sku] = resultRows<Record<string, unknown>>(skuResult);
  if (!sku) throw new ApiError(404, "SKU 不存在");
  if (sku.active !== true || sku.sku_type !== "finished") {
    throw new ApiError(409, "平台 SKU 只能认领到启用中的成品 SKU");
  }
  if (input.platform !== "tmall") return;

  const crosswalkResult = await tx.execute(sql`
    WITH latest AS (
      SELECT ir.import_job_id
      FROM integration_runs ir
      WHERE ir.connector = 'jdy'
        AND ir.stream = 'tmall-sku-crosswalk-observation'
        AND ir.status = 'succeeded'
        AND ir.import_job_id IS NOT NULL
        AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
        AND coalesce(ir.request_scope->>'emptySource', 'false') = 'false'
      ORDER BY ir.started_at DESC, ir.id DESC
      LIMIT 1
    )
    SELECT
      count(DISTINCT nullif(sr.payload->'_identity'->>'skuId', ''))::int AS identity_count,
      max(nullif(sr.payload->'_identity'->>'skuId', '')) AS sku_id
    FROM staging_rows sr
    INNER JOIN latest ON latest.import_job_id = sr.import_job_id
    WHERE sr.target_table = 'jdy_tmall_sku_crosswalk_observation'
      AND sr.status IN ('pending', 'validated', 'committed')
      AND nullif(trim(sr.payload->>'sourceDeletedAt'), '') IS NULL
      AND sr.payload->'data'->>'shopName' = ${input.shopName}
      AND sr.payload->'data'->>'platformSkuId' = ${input.platformSkuId}
  ` as SQL);
  const [crosswalk] = resultRows<Record<string, unknown>>(crosswalkResult);
  const identityCount = Number(crosswalk?.identity_count ?? 0);
  const crosswalkSkuId = Number(crosswalk?.sku_id ?? 0);
  if (identityCount > 1) {
    throw new ApiError(409, "该平台 SKU 在最新对照表中存在多个系统 SKU，请先完成人工归属裁决");
  }
  if (identityCount === 1 && crosswalkSkuId !== input.skuId) {
    throw new ApiError(
      409,
      `该平台 SKU 已由最新对照表映射到另一系统 SKU，不能登记相互矛盾的直接认领`,
    );
  }
}

async function claimOne(
  tx: AnyDb,
  actor: SessionUser,
  input: Pick<PlatformSkuClaimInput, "shopName" | "platformSkuId" | "skuId" | "platform"> & { note: string },
) {
  await assertClaimIsConsistent(tx, input);
  return ensureExternalSkuIdentifierInTransaction(tx, {
    skuId: input.skuId,
    value: platformSkuIdentifierValue(input.shopName, input.platformSkuId),
    scope: PLATFORM_SCOPES[input.platform],
    note: input.note,
  }, actor);
}

export async function claimPlatformSku(actor: SessionUser, input: unknown, dbArg?: AnyDb) {
  const v = platformSkuClaimSchema.parse(input);
  const db = dbArg ?? (await getDbAsync());
  const value = platformSkuIdentifierValue(v.shopName, v.platformSkuId);
  const scope = PLATFORM_SCOPES[v.platform];
  const result = await db.transaction(async (tx: AnyDb) =>
    claimOne(tx, actor, {
      ...v,
      note: v.note ?? `${v.platform === "pdd" ? "拼多多" : "天猫"}平台 SKU 认领（${v.shopName}）`,
    }),
  );
  // 读模型刷新是可丢弃的派生物：失败不回滚认领，只让页面等下一次同步重建
  let readModels: "refreshed" | "deferred" = "refreshed";
  try {
    await refreshPlatformSkuIdentityGap(db);
    await refreshJiandaoyunExternalDemandReadModel(db);
    await refreshExternalVelocity(db);
  } catch {
    readModels = "deferred";
  }
  return {
    identifierId: result.identifier.id,
    skuId: v.skuId,
    value,
    scope,
    created: result.created,
    reactivated: result.reactivated,
    readModels,
  };
}

export const platformSkuBulkClaimSchema = z.object({
  items: z.array(platformSkuClaimItemSchema).min(1).max(300),
});

/**
 * 批量认领：每行独立事务与审计，单行冲突（409）只记录到该行，不拖累其它行；
 * 读模型在整批结束后刷新一次。上限 300 行——超过就分批，避免一次锁太久。
 */
export async function claimPlatformSkusBulk(actor: SessionUser, input: unknown, dbArg?: AnyDb) {
  const v = platformSkuBulkClaimSchema.parse(input);
  const db = dbArg ?? (await getDbAsync());
  const results: { shopName: string; platformSkuId: string; skuId: number; ok: boolean; created?: boolean; error?: string }[] = [];
  for (const item of v.items) {
    try {
      const r = await db.transaction(async (tx: AnyDb) =>
        claimOne(tx, actor, {
          ...item,
          note: `${item.platform === "pdd" ? "拼多多" : "天猫"}平台 SKU 批量认领（${item.shopName}）`,
        }),
      );
      results.push({ ...item, ok: true, created: r.created });
    } catch (error) {
      results.push({ ...item, ok: false, error: (error as Error).message });
    }
  }
  let readModels: "refreshed" | "deferred" = "refreshed";
  try {
    await refreshPlatformSkuIdentityGap(db);
    await refreshJiandaoyunExternalDemandReadModel(db);
    await refreshExternalVelocity(db);
  } catch {
    readModels = "deferred";
  }
  return {
    total: results.length,
    claimed: results.filter((r) => r.ok && r.created).length,
    alreadyClaimed: results.filter((r) => r.ok && !r.created).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    readModels,
  };
}
