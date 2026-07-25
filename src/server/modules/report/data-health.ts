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
 *
 * ── 结构性告警（structural）──
 * 逐 SKU 评分之外，另有「不属于某一个 SKU、而属于整份主数据」的结构问题。
 * 目前一项：**BOM 嵌套**。rules/bom-explode 只做**单层**展开（见该文件 TODO），
 * 若某个子件自身也有生效 BOM，其下级需求会被静默漏算——不报错、不为零，
 * 只是数字偏小，是最难发现的一类错。当前数据 0 例（725 父件 / 3441 子件互不重叠），
 * 所以本项是「哪天有人建了半成品 BOM 就立刻示警」的哨兵，而不是待办。
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { num } from "@/server/core/svc";
import { detectDuplicates, type SkuLike } from "@/server/core/dedupe";
import { getOnHandBySku } from "@/server/core/stock-view";

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

/** 结构性告警：不归属单个 SKU 的主数据问题（无命中则数组为空，页面不占位） */
export interface StructuralWarning {
  key: "bom_nested";
  severity: "high" | "medium";
  title: string;
  /** 影响说明——写清「会错成什么样」，不写「请检查」 */
  impact: string;
  /** 命中的具体对象（截断前 20 条，count 为全量） */
  count: number;
  samples: string[];
}

export interface DataHealthResult {
  rows: DataHealthRow[];
  total: number;
  summary: DataHealthSummary;
  structural: StructuralWarning[];
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
    return { rows: [], total: 0, summary: { totalSkus: 0, fullyHealthy: 0, byDimension: emptyByDim() }, structural: [] };
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
  const bomRows: { id: number; skuId: number }[] = await db
    .select({ id: schema.boms.id, skuId: schema.boms.productSkuId })
    .from(schema.boms)
    .where(eq(schema.boms.status, "active"));
  const hasBom = new Set<number>(bomRows.map((r) => r.skuId));

  /* ── 结构性告警：BOM 嵌套（子件自身也有生效 BOM → 单层展开会漏算其下级需求） ── */
  const structural: StructuralWarning[] = [];
  if (bomRows.length > 0) {
    const lineRows: { materialSkuId: number }[] = await db
      .select({ materialSkuId: schema.bomLines.materialSkuId })
      .from(schema.bomLines)
      .where(inArray(schema.bomLines.bomId, bomRows.map((b) => b.id)));
    const nested = [...new Set(lineRows.map((l) => l.materialSkuId))].filter((id) => hasBom.has(id));
    if (nested.length > 0) {
      const nameById = new Map(skuRows.map((s) => [s.id, `${s.code} ${s.name}`]));
      structural.push({
        key: "bom_nested",
        severity: "high",
        title: `检测到 ${nested.length} 个物料既是子件、自身又有生效 BOM（多层 BOM）`,
        impact:
          "BOM 展开目前只做单层：这些物料的下级用量不会计入物料需求，" +
          "结果是需求量被静默算小（不报错、不为零），据此下单会缺料。" +
          "请先按多层结构人工核对这些物料的需求，或联系开发启用多层展开。",
        count: nested.length,
        samples: nested.slice(0, 20).map((id) => nameById.get(id) ?? `SKU#${id}`),
      });
    }
  }

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
    structural,
  };
}

/* ══════════════════════ 疑似重复主档（E5-09） ══════════════════════
 * 上面的评分回答「缺什么」；这里回答另一半——**「多了什么」**。
 * 同一实物被建了多条主档（同名不同码、一字之差、全半角混用、规格后缀差异），
 * 会让库存分散在多条 SKU 上、销量被割裂、补货对着每一条各算一遍。
 *
 * 三条纪律：
 * - **只产出候选，绝不自动合并**。合并牵动库存/台账/BOM，必须人工裁决。
 * - **给够裁决证据**。"哪条该留"不能靠猜：谁有生效 BOM、谁有在库、谁建档最早，
 *   都直接摆在行里。
 * - **把合并的真实代价说清**。若待并项身上还压着库存，合并就不是改主档的文书工作——
 *   得先把货调走或清零，否则库存会连同错误主档一起消失。`stockAtRisk` 就是这个提醒。
 */

export interface DupeMember {
  skuId: number;
  code: string;
  name: string;
  skuType: string;
  brand: string | null;
  /** 全网在库（D20 口径，core/stock-view 唯一实现） */
  onHand: number;
  /** 是否有生效 BOM——有 BOM 的通常是「正在用」的那条 */
  hasBom: boolean;
}

export interface DupeClusterRow {
  /** 簇内成员（按 skuId 升序） */
  members: DupeMember[];
  /** 簇内最高相似度 0~1 */
  topScore: number;
  reasons: string[];
  /** 跨品牌簇：同名不同品往往是正常的，需更谨慎 */
  crossBrand: boolean;
  /** 建议保留项（证据驱动的**建议**，不是自动执行） */
  suggestedKeepSkuId: number;
  keepReason: string;
  /** 待并项身上的在库合计；>0 表示合并前必须先处理库存 */
  stockAtRisk: number;
}

export interface DupeResult {
  rows: DupeClusterRow[];
  total: number;
  /** 参与扫描的 active SKU 数 */
  scanned: number;
  /** 涉及的 SKU 总数（= 各簇成员数之和） */
  affectedSkus: number;
  /** 有库存风险的簇数——这些不能只改主档 */
  clustersWithStock: number;
  threshold: number;
  note: string;
}

export async function getDuplicateCandidates(
  query: { q?: string; crossBrand?: boolean; page?: number; pageSize?: number; threshold?: number },
  dbArg?: AnyDb,
): Promise<DupeResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();
  // 阈值可微调但守住下限：低于 0.7 会把「面霜 vs 面膜」这类不同品也拖进来
  const threshold = Math.min(1, Math.max(0.7, query.threshold ?? 0.85));

  const skuRows: {
    id: number;
    code: string;
    name: string;
    skuType: string;
    brand: string | null;
  }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      skuType: schema.skus.skuType,
      brand: schema.brands.nameCn,
    })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(eq(schema.skus.active, true));

  const empty: DupeResult = {
    rows: [], total: 0, scanned: skuRows.length, affectedSkus: 0,
    clustersWithStock: 0, threshold, note: "未发现疑似重复主档",
  };
  if (skuRows.length === 0) return { ...empty, note: "无 active SKU" };

  const candidates: SkuLike[] = skuRows.map((s) => ({
    skuId: s.id, code: s.code, name: s.name, brand: s.brand,
  }));
  const clusters = detectDuplicates(candidates, { threshold });
  if (clusters.length === 0) return empty;

  /* ── 只为命中的 SKU 取证据，不为全量取 ── */
  const hitIds = [...new Set(clusters.flatMap((c) => c.members.map((m) => m.skuId)))];
  const onHandView = await getOnHandBySku(db, { skuIds: hitIds });
  const bomRows: { skuId: number }[] = await db
    .select({ skuId: schema.boms.productSkuId })
    .from(schema.boms)
    .where(and(eq(schema.boms.status, "active"), inArray(schema.boms.productSkuId, hitIds)));
  const hasBom = new Set<number>(bomRows.map((r) => r.skuId));
  const metaById = new Map(skuRows.map((s) => [s.id, s]));

  const all: DupeClusterRow[] = clusters.map((c) => {
    const members: DupeMember[] = c.members.map((m) => {
      const meta = metaById.get(m.skuId);
      return {
        skuId: m.skuId,
        code: m.code,
        name: m.name,
        skuType: meta?.skuType ?? "unknown",
        brand: m.brand ?? null,
        onHand: num(onHandView.bySku.get(m.skuId)),
        hasBom: hasBom.has(m.skuId),
      };
    });

    // 建议保留：有 BOM 优先 → 在库多者 → 建档最早（skuId 最小）
    const ranked = [...members].sort(
      (a, b) => Number(b.hasBom) - Number(a.hasBom) || b.onHand - a.onHand || a.skuId - b.skuId,
    );
    const keep = ranked[0];
    const keepReason = keep.hasBom
      ? "有生效 BOM，是正在使用的主档"
      : keep.onHand > 0
        ? `在库最多（${keep.onHand}）`
        : "建档最早，其余为后建的重复项";

    const stockAtRisk = members
      .filter((m) => m.skuId !== keep.skuId)
      .reduce((s, m) => s + Math.max(0, m.onHand), 0);

    return {
      members,
      topScore: c.topScore,
      reasons: c.reasons,
      crossBrand: c.crossBrand,
      suggestedKeepSkuId: keep.skuId,
      keepReason,
      stockAtRisk: Math.round(stockAtRisk * 10) / 10,
    };
  });

  let filtered = all;
  if (query.crossBrand === false) filtered = filtered.filter((r) => !r.crossBrand);
  if (q) {
    filtered = filtered.filter((r) =>
      r.members.some((m) => m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
    );
  }
  // 同品牌优先（更可能是真重复）→ 有库存风险的优先（代价最大）→ 相似度
  filtered = [...filtered].sort(
    (a, b) =>
      Number(a.crossBrand) - Number(b.crossBrand) ||
      Number(b.stockAtRisk > 0) - Number(a.stockAtRisk > 0) ||
      b.topScore - a.topScore,
  );

  const clustersWithStock = filtered.filter((r) => r.stockAtRisk > 0).length;
  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    scanned: skuRows.length,
    affectedSkus: filtered.reduce((s, r) => s + r.members.length, 0),
    clustersWithStock,
    threshold,
    note:
      `在 ${skuRows.length} 个 active SKU 中发现 ${filtered.length} 组疑似重复` +
      (clustersWithStock > 0
        ? `，其中 ${clustersWithStock} 组待并项仍有在库——这些必须先处理库存再合并，不能只改主档`
        : "") +
      "。以下均为候选，需人工裁决，系统不会自动合并。",
  };
}
