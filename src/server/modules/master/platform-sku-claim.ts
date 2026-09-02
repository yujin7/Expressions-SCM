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

import { getDbAsync } from "@/db";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { ensureExternalSkuIdentifierInTransaction } from "@/server/modules/master/sku-identifier";
import { PLATFORM_SKU_IDENTIFIER_SCOPE, refreshPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { refreshJiandaoyunExternalDemandReadModel } from "@/server/modules/report/external-demand-signal";
import type { AnyDb } from "@/server/core/svc";

export const platformSkuClaimSchema = z.object({
  shopName: z.string().trim().min(1, "店铺名必填").max(60),
  platformSkuId: z.string().trim().min(1, "平台 SKU ID 必填").max(40).regex(/^[A-Za-z0-9_-]+$/, "平台 SKU ID 只能是字母数字"),
  skuId: z.number().int().positive(),
  note: z.string().trim().max(200).optional(),
});
export type PlatformSkuClaimInput = z.infer<typeof platformSkuClaimSchema>;

export function platformSkuIdentifierValue(shopName: string, platformSkuId: string): string {
  const value = `${shopName.trim()}|${platformSkuId.trim()}`;
  if (value.length > 100) throw new ApiError(400, "店铺名 + 平台 SKU ID 超过标识长度上限");
  return value;
}

export async function claimPlatformSku(actor: SessionUser, input: unknown, dbArg?: AnyDb) {
  const v = platformSkuClaimSchema.parse(input);
  const db = dbArg ?? (await getDbAsync());
  const value = platformSkuIdentifierValue(v.shopName, v.platformSkuId);
  const result = await db.transaction(async (tx: AnyDb) =>
    ensureExternalSkuIdentifierInTransaction(tx, {
      skuId: v.skuId,
      value,
      scope: PLATFORM_SKU_IDENTIFIER_SCOPE,
      note: v.note ?? `天猫平台 SKU 认领（${v.shopName}）`,
    }, actor),
  );
  // 读模型刷新是可丢弃的派生物：失败不回滚认领，只让页面等下一次同步重建
  let readModels: "refreshed" | "deferred" = "refreshed";
  try {
    await refreshPlatformSkuIdentityGap(db);
    await refreshJiandaoyunExternalDemandReadModel(db);
  } catch {
    readModels = "deferred";
  }
  return {
    identifierId: result.identifier.id,
    skuId: v.skuId,
    value,
    scope: PLATFORM_SKU_IDENTIFIER_SCOPE,
    created: result.created,
    reactivated: result.reactivated,
    readModels,
  };
}

export const platformSkuBulkClaimSchema = z.object({
  items: z.array(platformSkuClaimSchema.omit({ note: true })).min(1).max(300),
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
      const value = platformSkuIdentifierValue(item.shopName, item.platformSkuId);
      const r = await db.transaction(async (tx: AnyDb) =>
        ensureExternalSkuIdentifierInTransaction(tx, {
          skuId: item.skuId, value, scope: PLATFORM_SKU_IDENTIFIER_SCOPE,
          note: `天猫平台 SKU 批量认领（${item.shopName}）`,
        }, actor),
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
