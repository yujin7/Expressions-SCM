/**
 * 条码补齐（人工确认后落库）。
 *
 * 2026-09-03 实核：系统 5,376 个启用 SKU 只有 692 个有条码，而数据中台里财务「货品档案」与
 * 聚水潭「商品资料」镜像都维护着「系统编码 ↔ 条码」，两者合计能为约 3,200 个 SKU 补上条码。
 * 条码是跨平台身份的通用键（天猫/唯品会对照表、简道云同步的 `_identity` 解析都靠它），
 * 补齐后后续同步会自动把更多外部行解析到系统 SKU。
 *
 * 纪律：读模型只提议，落库必须由人确认；这里**只写空白字段**、只接受未被其它 SKU 占用的条码，
 * 每行独立事务 + 审计（entity=sku, action=barcode_fill），单行冲突不拖累整批。
 * 不改名称/规格/任何其它主档字段，不碰库存与单据。
 */
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { getDbAsync } from "@/db";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import type { AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { refreshPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { assertPlatformIdentityWriter } from "./platform-identity-access";
import { assertSkuBarcodeOwnershipInTransaction, lockSkuIdentifierClaim } from "./sku-identifier";

export const skuBarcodeFillSchema = z.object({
  items: z.array(z.object({
    skuId: z.number().int().positive(),
    barcode: z.string().trim().min(6).max(32).regex(/^[0-9A-Za-z-]+$/, "条码只能是字母数字与连字符"),
  })).min(1).max(500),
  source: z.string().trim().max(60).default("jiandaoyun-master-mirror"),
});
export type SkuBarcodeFillInput = z.infer<typeof skuBarcodeFillSchema>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

async function fillOne(tx: AnyDb, actor: SessionUser, item: { skuId: number; barcode: string }, source: string) {
  // Same physical-code namespace as GTIN/legacy identifier claims; SKU row
  // locks alone cannot prevent two different SKUs taking one barcode.
  await lockSkuIdentifierClaim(tx, "legacy", item.barcode);
  const skuResult = await tx.execute(sql`SELECT id, code, barcode, active FROM skus WHERE id = ${item.skuId} FOR UPDATE` as SQL);
  const [sku] = resultRows<Record<string, unknown>>(skuResult);
  if (!sku) throw new ApiError(404, "SKU 不存在");
  if (sku.active !== true) throw new ApiError(409, "只能给启用中的 SKU 补条码");
  const current = String(sku.barcode ?? "").trim();
  await assertSkuBarcodeOwnershipInTransaction(tx, item.skuId, "legacy", item.barcode);
  if (current === item.barcode) return { skuId: item.skuId, status: "unchanged" as const };
  if (current) throw new ApiError(409, `SKU ${String(sku.code)} 已有条码 ${current}，不覆盖`);
  await tx.execute(sql`UPDATE skus SET barcode = ${item.barcode}, updated_at = now() WHERE id = ${item.skuId}` as SQL);
  await writeAudit(tx, {
    userId: actor.id,
    entity: "sku",
    entityId: item.skuId,
    action: "barcode_fill",
    before: { barcode: null },
    after: { barcode: item.barcode, source },
  });
  return { skuId: item.skuId, status: "filled" as const };
}

export async function fillSkuBarcodesBulk(actor: SessionUser, input: unknown, dbArg?: AnyDb) {
  assertPlatformIdentityWriter(actor);
  const v = skuBarcodeFillSchema.parse(input);
  const db = dbArg ?? (await getDbAsync());
  const results: { skuId: number; status: "filled" | "unchanged" | "conflict"; error?: string }[] = [];
  for (const item of v.items) {
    try {
      const r = await db.transaction(async (tx: AnyDb) => fillOne(tx, actor, item, v.source));
      results.push(r);
    } catch (error) {
      results.push({ skuId: item.skuId, status: "conflict", error: error instanceof Error ? error.message : "未知错误" });
    }
  }
  let readModels: "refreshed" | "deferred" = "refreshed";
  try {
    await refreshPlatformSkuIdentityGap(db);
  } catch {
    readModels = "deferred";
  }
  return {
    filled: results.filter((r) => r.status === "filled").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    conflicts: results.filter((r) => r.status === "conflict").length,
    results,
    readModels,
  };
}
