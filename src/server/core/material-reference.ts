/**
 * 旧流程包材参考事实（D16 / E2-08）。
 *
 * `transit_refs` 是只读参考层，不是库存账，也不能单独驱动采购或自动齐套：
 * - pkg_order：旧流程包材在途，数量取下单量；交期优先二次修改→采购回复→需求交期。
 * - pkg_stock：旧流程包材备料池，数量只取正的剩余量；它可能已被实时账覆盖，故只作旁证。
 *
 * 本模块只负责把已关联 `materialSkuId` 的参考行装配成统一、可追溯的事实。是否与某个
 * 成品需求匹配、是否展示参考 ETA，由调用方按 productSkuId 和业务语境决定。
 */
import { and, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dCmp, dQty } from "@/server/core/decimal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shared Drizzle/PGlite read helper
type AnyDb = any;

export type MaterialReferenceSource = "legacy_pkg_order" | "legacy_pkg_stock";

export interface MaterialReferenceLine {
  materialSkuId: number;
  /** 源文件中的成品归属；空表示无法安全分配给某个成品需求。 */
  productSkuId: number | null;
  qty: string;
  /** 仅 pkg_order 有到货语义；pkg_stock 的成品使用日不能冒充到货日。 */
  expectDate: string | null;
  source: MaterialReferenceSource;
  ref: string | null;
  asOf: string;
}

export async function getMaterialReferenceLines(
  db: AnyDb,
  materialSkuIds: number[],
): Promise<MaterialReferenceLine[]> {
  const ids = [...new Set(materialSkuIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return [];

  const t = schema.transitRefs;
  const rows: {
    kind: string;
    materialSkuId: number | null;
    productSkuId: number | null;
    qty: string | null;
    remainQty: string | null;
    revisedDate: string | null;
    replyDate: string | null;
    needDate: string | null;
    externalNo: string | null;
    approvalNo: string | null;
    feishuNo: string | null;
    createdAt: Date;
  }[] = await db
    .select({
      kind: t.kind,
      materialSkuId: t.materialSkuId,
      productSkuId: t.skuId,
      qty: t.qty,
      remainQty: t.remainQty,
      revisedDate: t.revisedDate,
      replyDate: t.replyDate,
      needDate: t.needDate,
      externalNo: t.externalNo,
      approvalNo: t.approvalNo,
      feishuNo: t.feishuNo,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(and(inArray(t.kind, ["pkg_order", "pkg_stock"]), inArray(t.materialSkuId, ids)));

  const lines: MaterialReferenceLine[] = [];
  for (const row of rows) {
    if (row.materialSkuId == null) continue;
    const isOrder = row.kind === "pkg_order";
    const qty = dQty(isOrder ? (row.qty ?? "0") : (row.remainQty ?? "0"));
    if (dCmp(qty, "0") <= 0) continue;
    lines.push({
      materialSkuId: row.materialSkuId,
      productSkuId: row.productSkuId,
      qty,
      expectDate: isOrder ? (row.revisedDate ?? row.replyDate ?? row.needDate ?? null) : null,
      source: isOrder ? "legacy_pkg_order" : "legacy_pkg_stock",
      ref: row.externalNo ?? row.approvalNo ?? row.feishuNo ?? null,
      asOf: row.createdAt.toISOString(),
    });
  }

  const sourceOrder: Record<MaterialReferenceSource, number> = {
    legacy_pkg_order: 0,
    legacy_pkg_stock: 1,
  };
  lines.sort(
    (a, b) =>
      a.materialSkuId - b.materialSkuId ||
      (a.productSkuId ?? Number.MAX_SAFE_INTEGER) - (b.productSkuId ?? Number.MAX_SAFE_INTEGER) ||
      sourceOrder[a.source] - sourceOrder[b.source] ||
      (a.expectDate == null ? 1 : 0) - (b.expectDate == null ? 1 : 0) ||
      (a.expectDate ?? "").localeCompare(b.expectDate ?? "") ||
      (a.ref ?? "").localeCompare(b.ref ?? ""),
  );
  return lines;
}
