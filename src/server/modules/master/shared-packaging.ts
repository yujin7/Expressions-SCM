/**
 * 共用包材（D36/0724 会议）：不同成品共用包材的关联展示 + 备货时包材可用量。
 * 全部由 BOM 事实派生（active BOM 的 packaging 物料 → 其他引用该物料的 active BOM 成品），
 * 不新增维护负担；可用量=实时账余额合计（参考口径，快照仓包材不计）。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface SharedPackagingItem {
  materialSkuId: number;
  materialCode: string;
  materialName: string;
  baseUom: string;
  qtyPer: string;
  onHand: string; // 实时账合计
  sharedWith: { code: string; name: string }[]; // 共用该包材的其他成品（≤8）
  sharedCount: number;
}

export async function getSharedPackaging(skuId: number, dbArg?: AnyDb): Promise<SharedPackagingItem[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  // 该成品 active BOM 的包材行
  const lines: { materialSkuId: number; qtyPer: string; code: string; name: string; baseUom: string }[] = await db
    .select({
      materialSkuId: schema.bomLines.materialSkuId,
      qtyPer: schema.bomLines.qtyPer,
      code: schema.skus.code,
      name: schema.skus.name,
      baseUom: schema.skus.baseUom,
    })
    .from(schema.boms)
    .innerJoin(schema.bomLines, eq(schema.bomLines.bomId, schema.boms.id))
    .innerJoin(schema.skus, eq(schema.bomLines.materialSkuId, schema.skus.id))
    .where(and(eq(schema.boms.productSkuId, skuId), eq(schema.boms.status, "active"), eq(schema.skus.skuType, "packaging")));
  if (lines.length === 0) return [];
  const matIds = lines.map((l) => l.materialSkuId);

  // 余额合计（实时账）
  const bal: { skuId: number; qty: string }[] = await db
    .select({ skuId: schema.stockBalances.skuId, qty: sql<string>`coalesce(sum(${schema.stockBalances.qty}), '0')` })
    .from(schema.stockBalances)
    .where(inArray(schema.stockBalances.skuId, matIds))
    .groupBy(schema.stockBalances.skuId);
  const balBySku = new Map(bal.map((b) => [b.skuId, b.qty]));

  // 共用者：引用同物料的其他 active BOM 成品
  const sharers: { materialSkuId: number; code: string; name: string; productSkuId: number }[] = await db
    .select({
      materialSkuId: schema.bomLines.materialSkuId,
      productSkuId: schema.boms.productSkuId,
      code: schema.skus.code,
      name: schema.skus.name,
    })
    .from(schema.bomLines)
    .innerJoin(schema.boms, and(eq(schema.bomLines.bomId, schema.boms.id), eq(schema.boms.status, "active")))
    .innerJoin(schema.skus, eq(schema.boms.productSkuId, schema.skus.id))
    .where(inArray(schema.bomLines.materialSkuId, matIds));
  const shareMap = new Map<number, { code: string; name: string }[]>();
  for (const s of sharers) {
    if (s.productSkuId === skuId) continue;
    const arr = shareMap.get(s.materialSkuId) ?? [];
    arr.push({ code: s.code, name: s.name });
    shareMap.set(s.materialSkuId, arr);
  }

  return lines.map((l) => {
    const all = shareMap.get(l.materialSkuId) ?? [];
    return {
      materialSkuId: l.materialSkuId,
      materialCode: l.code,
      materialName: l.name,
      baseUom: l.baseUom,
      qtyPer: l.qtyPer,
      onHand: balBySku.get(l.materialSkuId) ?? "0",
      sharedWith: all.slice(0, 8),
      sharedCount: all.length,
    };
  });
}
