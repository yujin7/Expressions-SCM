/**
 * 主数据健康度仪表（只读报表层）：逐 active SKU 评分主数据完整度并产出缺失清单。
 *
 * 口径（不新增字段，全部既有主档）：
 * - 适用维度按 skuType 裁剪——成品(finished)：生产周期+起订量+BOM+条码+品牌；
 *   其余类型（半成品/原料/包材/服务）仅：条码+品牌（不评 BOM/生产周期/起订量）。
 * - 生产周期缺失 = 无 sku_params.normalLeadDays>0（成品适用）
 * - 起订量缺失   = 无 uom_convs.moq>0（任一采购单位；成品适用）
 * - BOM 缺失     = 无生效版本 boms(status=active)（成品适用）
 * - 条码缺失     = barcodeStatus 为 null 或 'malformed'（全类型；duplicate 视为已有）
 * - 品牌缺失     = brandId 为空（全类型）
 * 完整度评分 = round(100 * (适用维度数 - 缺失数) / 适用维度数)；只读不写库。
 */
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { num } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** 维度中文标签（缺失项文案 & 汇总键；顺序即展示顺序） */
const DIM_LEAD = "生产周期";
const DIM_MOQ = "起订量";
const DIM_BOM = "BOM";
const DIM_BARCODE = "条码";
const DIM_BRAND = "品牌";
const ALL_DIMS = [DIM_LEAD, DIM_MOQ, DIM_BOM, DIM_BARCODE, DIM_BRAND] as const;

export interface DataHealthRow {
  skuId: number;
  code: string;
  name: string;
  skuType: string;
  brand: string | null;
  /** 缺失维度中文标签 */
  missing: string[];
  /** 完整度评分 0-100（适用维度完整占比） */
  score: number;
}

export interface DataHealthSummary {
  totalSkus: number;
  fullyHealthy: number;
  byDimension: Record<string, number>;
}

export interface DataHealthResult {
  rows: DataHealthRow[];
  total: number;
  summary: DataHealthSummary;
}

export async function getDataHealth(
  query: { q?: string; missing?: string; page?: number; pageSize?: number },
  dbArg?: AnyDb,
): Promise<DataHealthResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();
  const missingFilter = (query.missing ?? "").trim();

  /* ── active SKU 主档（全类型；含品牌名） ── */
  const skuRows: {
    id: number;
    code: string;
    name: string;
    skuType: string;
    brandId: number | null;
    barcodeStatus: string | null;
    brand: string | null;
  }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      skuType: schema.skus.skuType,
      brandId: schema.skus.brandId,
      barcodeStatus: schema.skus.barcodeStatus,
      brand: schema.brands.nameCn,
    })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(eq(schema.skus.active, true));

  const emptyByDim = (): Record<string, number> => Object.fromEntries(ALL_DIMS.map((d) => [d, 0]));
  if (skuRows.length === 0) {
    return { rows: [], total: 0, summary: { totalSkus: 0, fullyHealthy: 0, byDimension: emptyByDim() } };
  }

  /* ── 生产周期：sku_params.normalLeadDays>0 ── */
  const leadRows: { skuId: number; normalLeadDays: number | null }[] = await db
    .select({ skuId: schema.skuParams.skuId, normalLeadDays: schema.skuParams.normalLeadDays })
    .from(schema.skuParams);
  const hasLead = new Set<number>(leadRows.filter((r) => num(r.normalLeadDays) > 0).map((r) => r.skuId));

  /* ── 起订量：uom_convs.moq>0（任一采购单位） ── */
  const moqRows: { skuId: number; moq: string | null }[] = await db
    .select({ skuId: schema.uomConvs.skuId, moq: schema.uomConvs.moq })
    .from(schema.uomConvs);
  const hasMoq = new Set<number>(moqRows.filter((r) => num(r.moq) > 0).map((r) => r.skuId));

  /* ── BOM：存在生效版本（status=active） ── */
  const bomRows: { skuId: number }[] = await db
    .select({ skuId: schema.boms.productSkuId })
    .from(schema.boms)
    .where(eq(schema.boms.status, "active"));
  const hasBom = new Set<number>(bomRows.map((r) => r.skuId));

  /* ── 逐 SKU 判定 ── */
  const byDimension = emptyByDim();
  let fullyHealthy = 0;
  const all: DataHealthRow[] = [];

  for (const sku of skuRows) {
    const isFinished = sku.skuType === "finished";
    const missing: string[] = [];
    let applicable = 2; // 全类型：条码 + 品牌

    if (isFinished) {
      applicable += 3; // 成品专属：生产周期 + 起订量 + BOM
      if (!hasLead.has(sku.id)) missing.push(DIM_LEAD);
      if (!hasMoq.has(sku.id)) missing.push(DIM_MOQ);
      if (!hasBom.has(sku.id)) missing.push(DIM_BOM);
    }
    if (sku.barcodeStatus == null || sku.barcodeStatus === "malformed") missing.push(DIM_BARCODE);
    if (sku.brandId == null) missing.push(DIM_BRAND);

    for (const m of missing) byDimension[m] = (byDimension[m] ?? 0) + 1;
    if (missing.length === 0) {
      fullyHealthy++;
      continue; // 完全健康：不入列表，仅计入汇总
    }
    const score = Math.round((100 * (applicable - missing.length)) / applicable);
    all.push({ skuId: sku.id, code: sku.code, name: sku.name, skuType: sku.skuType, brand: sku.brand, missing, score });
  }

  /* ── 筛选 / 排序（评分升序，最差在前） / 分页 ── */
  let filtered = all;
  if (missingFilter) filtered = filtered.filter((r) => r.missing.includes(missingFilter));
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  filtered.sort((a, b) => a.score - b.score || b.missing.length - a.missing.length || a.code.localeCompare(b.code));

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    summary: { totalSkus: skuRows.length, fullyHealthy, byDimension },
  };
}
