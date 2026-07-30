/**
 * 主数据健康度仪表（只读报表层）：逐 active SKU 评分主数据完整度并产出缺失清单。
 *
 * 口径（不新增字段，全部既有主档）：
 * - 完整度评分只评价成品(finished)：生产周期+起订量+BOM+条码+品牌。
 *   原料/包材没有零售条码与消费品牌在当前 BOM 数据模型中是正常的，不应被伪装成缺陷；
 *   它们仍参与「疑似重复」扫描，未来有经业务确认的物料专属必填项后再独立评分。
 * - 生产周期缺失 = 无 sku_params.normalLeadDays>0（成品适用）
 * - 起订量缺失   = 无 uom_convs.moq>0（任一采购单位；成品适用）
 * - BOM 缺失     = 无生效版本 boms(status=active)（成品适用）
 * - 条码缺失     = barcodeStatus 为 null 或 'malformed'（全类型；duplicate 视为已有）
 * - 品牌缺失     = brandId 为空（全类型）
 * 完整度评分 = round(100 * (适用维度数 - 缺失数) / 适用维度数)；只读不写库。
 *
 * ── 结构性告警（structural）──
 * 逐 SKU 评分之外，另有「不属于某一个 SKU、而属于整份主数据」的结构问题。
 * 多层 BOM 已由 rules/bom-explode 递归展开；真正不可计算的是**循环**或异常深度。
 * 新 BOM 在生效事务内被阻断，健康度仍扫描存量/迁移数据，避免历史污染静默低估需求。
 *
 * 第二项：**临期阈值低于渠道通行口径**。效期在美妆是渠道准入约束而非仓库报表——
 * 天猫对部分美妆类目按 max(保质期×2/10, 100天) 判临期。系统阈值若更低，
 * 就会「系统判健康、渠道判临期」。本项只呈现差距，**不自动改阈值**：
 * 阈值属业务与渠道合同的口径，不归代码裁决（同 CLAUDE.md「口径归业务」纪律）。
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { num } from "@/server/core/svc";
import { detectDuplicates, type SkuLike } from "@/server/core/dedupe";
import { getOnHandBySku } from "@/server/core/stock-view";
import {
  BomDepthError,
  findBomCycleFrom,
  type BomLineLike,
} from "@/server/rules/bom-explode";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
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
  key: "bom_cycle" | "bom_depth" | "near_expiry_below_channel" | "near_expiry_using_default" | "shelf_life_missing";
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
    shelfLifeDays: number | null;
    nearExpiryDays: number | null;
  }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      skuType: schema.skus.skuType,
      brandId: schema.skus.brandId,
      barcodeStatus: schema.skus.barcodeStatus,
      brand: schema.brands.nameCn,
      shelfLifeDays: schema.skus.shelfLifeDays,
      nearExpiryDays: schema.skus.nearExpiryDays,
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

  /* ── 结构性告警：循环/异常深度（合法多层 BOM 不再误报） ── */
  const structural: StructuralWarning[] = [];
  if (bomRows.length > 0) {
    const lineRows: Array<BomLineLike & { productSkuId: number }> = await db
      .select({
        productSkuId: schema.boms.productSkuId,
        materialSkuId: schema.bomLines.materialSkuId,
        qtyPer: schema.bomLines.qtyPer,
        incomingLossPct: schema.bomLines.incomingLossPct,
        productionLossPct: schema.bomLines.productionLossPct,
        lossRatePct: schema.bomLines.lossRatePct,
      })
      .from(schema.boms)
      .innerJoin(schema.bomLines, eq(schema.bomLines.bomId, schema.boms.id))
      .where(inArray(schema.boms.id, bomRows.map((b) => b.id)));
    const graph = new Map<number, BomLineLike[]>();
    for (const line of lineRows) {
      const rows = graph.get(line.productSkuId) ?? [];
      rows.push(line);
      graph.set(line.productSkuId, rows);
    }
    const cycles = new Map<string, number[]>();
    const tooDeep = new Set<number>();
    for (const root of graph.keys()) {
      try {
        const cycle = findBomCycleFrom(root, graph);
        if (!cycle) continue;
        const key = [...new Set(cycle.slice(0, -1))].sort((a, b) => a - b).join(",");
        if (!cycles.has(key)) cycles.set(key, cycle);
      } catch (error) {
        if (error instanceof BomDepthError) {
          tooDeep.add(root);
          continue;
        }
        throw error;
      }
    }
    const nameById = new Map(skuRows.map((s) => [s.id, `${s.code} ${s.name}`]));
    if (cycles.size > 0) {
      structural.push({
        key: "bom_cycle",
        severity: "high",
        title: `检测到 ${cycles.size} 条存量 BOM 循环`,
        impact:
          "循环 BOM 没有有限的末级物料需求，系统会整根阻断而不返回部分数字。" +
          "新版本生效已在事务内拦截；此处命中表示存量或迁移数据需先修复。",
        count: cycles.size,
        samples: [...cycles.values()].slice(0, 20).map(
          (cycle) => cycle.map((id) => nameById.get(id) ?? `SKU#${id}`).join(" → "),
        ),
      });
    }
    if (tooDeep.size > 0) {
      structural.push({
        key: "bom_depth",
        severity: "high",
        title: `${tooDeep.size} 个 BOM 根节点超过 32 层安全上限`,
        impact:
          "异常深度通常意味着错误引用或失控的半成品链。系统会阻断这些根节点的需求计算，" +
          "避免递归耗尽或把截断结果冒充完整需求。",
        count: tooDeep.size,
        samples: [...tooDeep].slice(0, 20).map((id) => nameById.get(id) ?? `SKU#${id}`),
      });
    }
  }

  /* ── 结构性告警：临期阈值低于渠道通行口径 ──
     效期在美妆是**渠道准入约束**，不是仓库报表：天猫对部分美妆类目定义
     临期 = max(总保质期 × 2/10, 100 天)，多平台对剩余 90/180 天以下要求临期标注与不可退。
     若系统阈值低于渠道口径，会出现「系统判健康、渠道判临期」——货发不出去，
     且补货建议不会为这批货预留提前处置的时间。
     纪律：本项只**呈现差距**，不自动改阈值——阈值是业务与渠道合同的口径，不归代码裁决。 ── */
  const CHANNEL_RULE = (shelf: number) => Math.max(Math.round(shelf * 0.2), 100);
  const DEFAULT_NEAR = 90; // 与 report/risk.ts 的兜底一致
  {
    const finished = skuRows.filter((s) => s.skuType === "finished");
    const hasShelf = finished.filter((s) => s.shelfLifeDays != null && s.shelfLifeDays > 0);
    const noShelf = finished.filter((s) => s.shelfLifeDays == null || s.shelfLifeDays <= 0);

    /* 先报「算不出来」——缺保质期就无法判临期口径。
       若沉默跳过，本项会在数据缺失时显示「无异常」，把「没问题」和「没法查」混为一谈，
       这正是本项目反复出现的静默截断缺陷类。 */
    if (noShelf.length > 0) {
      structural.push({
        key: "shelf_life_missing",
        severity: "medium",
        title: `${noShelf.length} / ${finished.length} 个在售成品的主档保质期为空，渠道临期口径无法评估`,
        impact:
          "现有效期能力（效期分层 / 临期预警 / FEFO）读的是 batch_stocks.expiryDate，**不受本项影响，仍正常工作**。" +
          "本项卡住的是另外两件事：① 无法与渠道口径（天猫等按 max(保质期×2/10, 100天) 判临期）比对，" +
          "也就无法回答「我们的临期阈值够不够渠道用」；② 批次缺效期时无法由生产日期推算。" +
          "根因已变（2026-07-25 复核）：放行引擎的回填已在 engine.ts:1261-1273 落地，" +
          "存量 391 个已回填、重跑待回填为 0。**剩余这些的真实原因是源文件里就没有这一列**——" +
          "即「没采集」，不是「解析了没落库」。因此要做的是补采（让效期文件带上保质期列后重导），" +
          "而不是去改放行引擎。D13 已裁定缺省 1095 天，也可按该缺省批量落档。",
        count: noShelf.length,
        samples: noShelf.slice(0, 20).map((s) => `${s.code} ${s.name}`),
      });
    }

    /*
     * 临期阈值 vs 渠道口径。**这里必须区分两件性质完全不同的事**，否则会变成一条
     * 命中率 100% 的噪音：曾经把「用缺省值」和「设错了」混在一起报，
     * 结果 391/391 全部命中——而实际上 0 个 SKU 显式设过阈值，
     * 391 条讲的是同一件事（全局缺省 90 天低于渠道口径），却摆成 391 个待办。
     *
     * ① 显式设过、但低于渠道口径 → **真的逐 SKU 配置错误**，值得逐条列出。
     * ② 从没设过、吃全局缺省      → 这是**一个**设定决策，不是 N 个问题；
     *    合并成一句话，不给逐 SKU 清单（给了就是假装有 N 件事要做）。
     */
    const explicitBelow = hasShelf
      .filter((s) => s.nearExpiryDays != null)
      .map((s) => ({ s, need: CHANNEL_RULE(s.shelfLifeDays as number), cur: s.nearExpiryDays as number }))
      .filter((x) => x.cur < x.need);
    if (explicitBelow.length > 0) {
      explicitBelow.sort((a, b) => b.need - b.cur - (a.need - a.cur));
      structural.push({
        key: "near_expiry_below_channel",
        severity: "medium",
        title: `${explicitBelow.length} 个成品**已设定**的临期阈值低于渠道通行口径 max(保质期×2/10, 100天)`,
        impact:
          "这些 SKU 有人显式设过阈值，但设得比渠道口径松：会出现「系统判健康、渠道判临期」——" +
          "货已不能正常上架/不可退，系统却既不预警、也不在补货建议里为提前处置留时间。" +
          "请按各平台实际合同核准后在 SKU 主档逐项修正——系统不代改，因为这是渠道口径不是代码常量。",
        count: explicitBelow.length,
        samples: explicitBelow.slice(0, 20).map(
          (x) => `${x.s.code}（保质期 ${x.s.shelfLifeDays} 天，现阈值 ${x.cur}，渠道口径 ≥${x.need}）`,
        ),
      });
    }

    const usingDefault = hasShelf.filter((s) => s.nearExpiryDays == null);
    if (usingDefault.length > 0) {
      const needs = usingDefault.map((s) => CHANNEL_RULE(s.shelfLifeDays as number));
      const minNeed = Math.min(...needs);
      const shortfall = needs.filter((n) => DEFAULT_NEAR < n).length;
      if (shortfall > 0) {
        structural.push({
          key: "near_expiry_using_default",
          severity: "medium",
          // 一句话陈述一个全局事实——不摆成 N 条待办
          title: `临期阈值尚未逐 SKU 设定：${usingDefault.length} 个有保质期的成品在吃全局缺省 ${DEFAULT_NEAR} 天`,
          impact:
            `其中 ${shortfall} 个的渠道口径要求 ≥${minNeed} 天，缺省值偏松。` +
            "这是**一个设定决策、不是 N 个问题**：需要业务按各平台合同确认阈值口径，再逐类落到 SKU 主档。" +
            "系统不代设——渠道口径属于商务条款，不是代码常量。在设定之前，效期分层与临期预警仍按缺省值工作。",
          count: usingDefault.length,
          samples: [], // 刻意不给逐 SKU 清单：列出来会让人以为有 N 件事要办，实际只有一件
        });
      }
    }
  }

  /* ── 逐成品 SKU 判定 ──
     原料/包材若按条码+品牌打分，会把 4,350 条「不适用」误报成缺失，健康率失真。 */
  const evaluatedSkus = skuRows.filter((sku) => sku.skuType === "finished");
  const byDimension = emptyByDim();
  let fullyHealthy = 0;
  const all: DataHealthRow[] = [];

  for (const sku of evaluatedSkus) {
    const missing: string[] = [];
    const applicable = 5;
    if (!hasLead.has(sku.id)) missing.push(DIM_LEAD);
    if (!hasMoq.has(sku.id)) missing.push(DIM_MOQ);
    if (!hasBom.has(sku.id)) missing.push(DIM_BOM);
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
    summary: { totalSkus: evaluatedSkus.length, fullyHealthy, byDimension },
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
  /** 归一化后完全同名的簇数（几乎必然是真重复，建议优先处理） */
  exactCount: number;
  threshold: number;
  note: string;
}

export async function getDuplicateCandidates(
  query: {
    q?: string;
    crossBrand?: boolean;
    /** 只看归一化后完全同名的簇——真实数据上这部分只有几十组，可以当天处理完 */
    exactOnly?: boolean;
    page?: number;
    pageSize?: number;
    threshold?: number;
  },
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
    clustersWithStock: 0, exactCount: 0, threshold, note: "未发现疑似重复主档",
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

  const exactCount = all.filter((r) => r.topScore === 1).length;

  let filtered = all;
  if (query.crossBrand === false) filtered = filtered.filter((r) => !r.crossBrand);
  if (query.exactOnly) filtered = filtered.filter((r) => r.topScore === 1);
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
    exactCount,
    threshold,
    note:
      `在 ${skuRows.length} 个 active SKU 中发现 ${filtered.length} 组疑似重复` +
      (exactCount > 0 ? `，其中 ${exactCount} 组归一化后完全同名（几乎必然是真重复，建议先处理这批）` : "") +
      (clustersWithStock > 0
        ? `；${clustersWithStock} 组待并项仍有在库——这些必须先处理库存再合并，不能只改主档`
        : "") +
      "。以下均为候选，需人工裁决，系统不会自动合并。",
  };
}
