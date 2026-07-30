/**
 * E2-07 物料需求展开（MRP）：成品需求经生效 BOM 展开成物料的**相关需求**，并做物料侧净额化。
 *
 * 口径纪律（本页为**采购前瞻**而非承诺）：
 * - 相关需求 = 在制 + 计划 两路，各自单列可追溯：
 *   (a) 在制：WO（status ∈ approved/in_progress 且 isPaused=false）的**剩余产出**
 *       = WO 数量 − Σ 其 JG 已生效 SH 正常行实收（与 report/wip.ts pendingQty 同口径），逐单下限 0；
 *   (b) 计划：成品补货建议量（report 层 R11 建议，getReplenishSuggestions）——「若采纳则需要的物料」。
 *       建议层≠承诺：成品建议未必被采纳，故本页数值是前瞻，不得直接当作已定采购量下单。
 * - 展开公式：rules/bom-explode.ts（与 outsource/wo.ts 快照**同一双损耗公式**，含 legacy 回退）；
 *   支持多层 BOM，逐层应用损耗并只汇总末级物料；循环/异常深度整根阻断，不返回部分低估结果。
 * - 生效 BOM 判定：boms.status='active'（与 wo.ts createWo 完全一致，一成品至多一条，部分唯一索引保证）。
 * - 物料侧净额化：在库 = Σ stock_balances（物料不走成品快照仓口径）；
 *   在途 = 已审批/执行中 PO 实物行未收量（基础单位 = qty×uomFactor − receivedQty，逐行下限 0，与 wo.ts/R11 同口径）；
 *   建议采购量 = rules/netreq.ts suggestQty()（MOQ/订货倍数取 uom_convs 首行，按 id，与既有 PoC 口径一致）。
 * - 全程只读：不写库、不开单、不落审计；无金额字段，免脱敏。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dMax, dQty, dSub } from "@/server/core/decimal";
import { getMaterialReferenceLines } from "@/server/core/material-reference";
import { getOpenSupplyLines } from "@/server/core/supply";
import { suggestQty } from "@/server/rules/netreq";
import {
  BomCycleError,
  BomDepthError,
  explode,
  type BomLineLike,
} from "@/server/rules/bom-explode";
import { earliestKitDate } from "@/server/rules/kitting-atp";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import { todayShanghai } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 与 report/wip.ts 一致：已生效 SH（正常行实收占用 JG 累计） */
const ACTIVE_SH_STATUSES = ["approved", "in_progress", "completed"] as const;

export interface MaterialDemandRow {
  materialSkuId: number;
  code: string;
  name: string;
  baseUom: string;
  /** 毛需求 = fromWip + fromPlan（qty scale=4） */
  grossReq: string;
  /** 其中：在制 WO 剩余产出带来的物料需求 */
  fromWip: string;
  /** 其中：成品补货建议（计划层）带来的物料需求 */
  fromPlan: string;
  /** 在库（Σ stock_balances） */
  onHand: string;
  /** PO 在途（已审批/执行中未收量） */
  inTransit: string;
  /** 旧流程包材在途，仅参考；只计与本次需求成品匹配的行 */
  referenceInTransit: string;
  /** 旧流程包材备料剩余，仅参考；只计与本次需求成品匹配的行 */
  referenceReserved: string;
  /** 有物料关联但无法匹配到本次需求成品的参考量，不参与参考缺口 */
  referenceUnallocated: string;
  /** 仅供人工判断：系统净需求再扣匹配的旧台账在途/备料；不驱动建议采购量 */
  referenceAwareGap: string;
  /** 仅按实时账+有日期系统 PO 推演；无日期供给不臆造 */
  systemEta: string | null;
  /** 在系统 ETA 上叠加匹配的旧台账旁证；绝不驱动自动链 */
  referenceEta: string | null;
  referenceEvidenceCount: number;
  /** 净需求 = max(0, 毛需求 − 在库 − 在途)，未过 MOQ/倍数 */
  netReq: string;
  /** 建议采购量 = R11（MOQ 托底 + 订货倍数向上取整） */
  suggestQty: string;
  /** 该物料被多少个成品的生效 BOM 共用（共用包材/共用原料预警） */
  sharedCount: number;
  /** 贡献毛需求最大的前 3 个成品编码 */
  topProducts: string[];
}

export interface MaterialDemandResult {
  rows: MaterialDemandRow[];
  total: number;
  summary: {
    /** 涉及物料数（不受分页影响） */
    materialCount: number;
    /** 缺口物料数（净需求 > 0） */
    shortageCount: number;
    /** 在制来源 WO 数 */
    wipWoCount: number;
    /** 计划来源成品建议行数 */
    planSkuCount: number;
    /** 有需求但无生效 BOM 的成品编码（展开断链，最值得人工补 BOM） */
    missingBomProducts: string[];
    /** BOM 循环或异常深度导致整根未参与计算；不得把部分结果冒充完整需求 */
    bomIssues: string[];
    /** 在制路交期窗口（天） */
    horizonDays: number;
    /** 口径日（Asia/Shanghai） */
    today: string;
    /** 已匹配到当前需求成品的旧包材参考行数 */
    referenceMatchedLines: number;
    /** 有旧包材参考旁证的物料数 */
    referenceMaterialCount: number;
    /** 旧包材参考数据最近导入时点 */
    referenceAsOf: string | null;
  };
}

export interface MaterialDemandQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  /** 在制路交期窗口：仅计入 dueDate ≤ 今日+N 天（或无交期）的 WO；默认 90 */
  horizonDays?: number;
}

/** 日期加天（Asia/Shanghai 日期字符串，与 expiry/risk 同准） */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);
}

export async function getMaterialDemand(
  query: MaterialDemandQuery,
  dbArg?: AnyDb,
): Promise<MaterialDemandResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(999, Math.max(1, query.pageSize ?? 50));
  const horizonDays = Math.min(365, Math.max(1, Math.floor(query.horizonDays ?? 90)));
  const q = (query.q ?? "").trim().toLowerCase();
  const today = todayShanghai();
  const horizonEnd = addDays(today, horizonDays);

  const empty = (s?: Partial<MaterialDemandResult["summary"]>): MaterialDemandResult => ({
    rows: [],
    total: 0,
    summary: {
      materialCount: 0, shortageCount: 0, wipWoCount: 0, planSkuCount: 0,
      missingBomProducts: [], bomIssues: [], horizonDays, today,
      referenceMatchedLines: 0, referenceMaterialCount: 0, referenceAsOf: null,
      ...s,
    },
  });

  /* ── (a) 在制：WO 剩余产出 ───────────────────────────────
     WO（已审批/执行中、未暂停）数量 − Σ 其 JG 已生效 SH 正常行实收，逐单下限 0。
     交期窗口：dueDate ≤ 今日+horizonDays，或无交期（无交期不敢丢，按窗内处理）。 */
  const woRows: { id: number; productSkuId: number; qty: string; dueDate: string | null }[] = await db
    .select({
      id: schema.woDocs.id,
      productSkuId: schema.woDocs.productSkuId,
      qty: schema.woDocs.qty,
      dueDate: schema.woDocs.dueDate,
    })
    .from(schema.woDocs)
    .where(and(
      inArray(schema.woDocs.status, ["approved", "in_progress"]),
      eq(schema.woDocs.isPaused, false),
      sql`(${schema.woDocs.dueDate} is null or ${schema.woDocs.dueDate} <= ${horizonEnd})`,
    ));

  const wipByProduct = new Map<number, string>();
  let wipWoCount = 0;
  if (woRows.length > 0) {
    const woIds = woRows.map((r) => r.id);
    // WO → 其 JG（一 WO 多批，D33）
    const jgRows: { id: number; woId: number }[] = await db
      .select({ id: schema.jgDocs.id, woId: schema.jgDocs.woId })
      .from(schema.jgDocs)
      .where(inArray(schema.jgDocs.woId, woIds));
    const woByJg = new Map(jgRows.map((r) => [r.id, r.woId]));
    const receivedByWo = new Map<number, string>();
    if (jgRows.length > 0) {
      // 已生效 SH 正常行实收（与 wip.ts pendingQty 分子一致：返工重交冲抵原不合格、备品不占累计）
      const shRows: { jgId: number; qty: string | null }[] = await db
        .select({ jgId: schema.shDocs.sourceId, qty: sql<string | null>`sum(${schema.shLines.actualQty})` })
        .from(schema.shLines)
        .innerJoin(schema.shDocs, eq(schema.shLines.shId, schema.shDocs.id))
        .where(and(
          eq(schema.shDocs.sourceType, "jg"),
          inArray(schema.shDocs.sourceId, jgRows.map((r) => r.id)),
          inArray(schema.shDocs.status, [...ACTIVE_SH_STATUSES]),
          eq(schema.shLines.lineType, "normal"),
        ))
        .groupBy(schema.shDocs.sourceId);
      for (const r of shRows) {
        const woId = woByJg.get(r.jgId);
        if (woId == null) continue;
        receivedByWo.set(woId, dAdd(receivedByWo.get(woId) ?? "0", r.qty ?? "0", 6));
      }
    }
    for (const w of woRows) {
      const remain = dMax(dSub(w.qty, receivedByWo.get(w.id) ?? "0", 6), "0", 6); // 逐单下限 0（超收不抵扣其他单）
      if (dCmp(remain, "0") <= 0) continue;
      wipWoCount++;
      wipByProduct.set(w.productSkuId, dAdd(wipByProduct.get(w.productSkuId) ?? "0", remain, 6));
    }
  }

  /* ── (b) 计划：成品补货建议量（建议层，非承诺） ───────────────
     注：getReplenishSuggestions 内部把 pageSize 夹到 999，故最多取回 999 行；
     其排序为「可销天数升序」= 最紧急优先，被截断的都是不紧急且多半无建议的行。 */
  const planByProduct = new Map<number, string>();
  const codeBySku = new Map<number, string>();
  let planSkuCount = 0;
  const replenish = await getReplenishSuggestions({ allRows: true }, db);
  for (const r of replenish.rows) {
    if (r.suggestQty == null || dCmp(r.suggestQty, "0") <= 0) continue;
    planSkuCount++;
    planByProduct.set(r.skuId, dAdd(planByProduct.get(r.skuId) ?? "0", r.suggestQty, 6));
    codeBySku.set(r.skuId, r.code);
  }

  const productIds = [...new Set([...wipByProduct.keys(), ...planByProduct.keys()])];
  if (productIds.length === 0) return empty();

  // 成品编码（在制路的 WO 成品不在补货建议里，需补查——否则断链名单只能显示 #id）
  const prodRows: { id: number; code: string }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code })
    .from(schema.skus)
    .where(inArray(schema.skus.id, productIds));
  for (const p of prodRows) codeBySku.set(p.id, p.code);

  /* ── 全量生效 BOM 图（status='active'，与 wo.ts 判定一致） ──
     多层展开必须加载可达半成品的下级 BOM；只查根成品会把半成品误当采购末级。 */
  const bomRows: {
    productSkuId: number; productCode: string; materialSkuId: number;
    qtyPer: string; incomingLossPct: string; productionLossPct: string; lossRatePct: string;
  }[] = await db
    .select({
      productSkuId: schema.boms.productSkuId,
      productCode: schema.skus.code,
      materialSkuId: schema.bomLines.materialSkuId,
      qtyPer: schema.bomLines.qtyPer,
      incomingLossPct: schema.bomLines.incomingLossPct,
      productionLossPct: schema.bomLines.productionLossPct,
      lossRatePct: schema.bomLines.lossRatePct,
    })
    .from(schema.boms)
    .innerJoin(schema.bomLines, eq(schema.bomLines.bomId, schema.boms.id))
    .innerJoin(schema.skus, eq(schema.boms.productSkuId, schema.skus.id))
    .where(eq(schema.boms.status, "active"))
    .orderBy(asc(schema.bomLines.id));

  const bomByProduct = new Map<number, BomLineLike[]>();
  for (const l of bomRows) {
    codeBySku.set(l.productSkuId, l.productCode);
    const arr = bomByProduct.get(l.productSkuId) ?? [];
    arr.push(l);
    bomByProduct.set(l.productSkuId, arr);
  }
  const missingBomProducts = productIds
    .filter((id) => !bomByProduct.has(id))
    .map((id) => codeBySku.get(id) ?? `#${id}`)
    .sort();

  /* ── 多层展开：逐根成品计算末级物料，两路分别累加 ── */
  const grossWip = new Map<number, string>();
  const grossPlan = new Map<number, string>();
  /** 物料 → (成品编码 → 贡献毛需求)，用于 topProducts */
  const contribByMaterial = new Map<number, Map<string, string>>();
  /** 物料 → 本次确有需求的成品；旧台账必须命中该集合才可进入参考缺口。 */
  const contributingProductsByMaterial = new Map<number, Set<number>>();
  const bomIssues: string[] = [];
  for (const pid of productIds) {
    if (!bomByProduct.has(pid)) continue;
    const pCode = codeBySku.get(pid) ?? `#${pid}`;
    const wipQty = wipByProduct.get(pid) ?? "0";
    const planQty = planByProduct.get(pid) ?? "0";
    let wipLeaves: Map<number, string>;
    let planLeaves: Map<number, string>;
    try {
      wipLeaves = dCmp(wipQty, "0") > 0 ? explode([{ skuId: pid, qty: wipQty }], bomByProduct) : new Map();
      planLeaves = dCmp(planQty, "0") > 0 ? explode([{ skuId: pid, qty: planQty }], bomByProduct) : new Map();
    } catch (error) {
      if (error instanceof BomCycleError) {
        const path = error.cycle.map((id) => codeBySku.get(id) ?? `#${id}`).join(" → ");
        bomIssues.push(`${pCode}：循环 ${path}`);
        continue;
      }
      if (error instanceof BomDepthError) {
        bomIssues.push(`${pCode}：层级超过安全上限`);
        continue;
      }
      throw error;
    }
    const leafIds = new Set([...wipLeaves.keys(), ...planLeaves.keys()]);
    for (const materialSkuId of leafIds) {
      const gw = wipLeaves.get(materialSkuId) ?? "0";
      const gp = planLeaves.get(materialSkuId) ?? "0";
      const total = dAdd(gw, gp, 6);
      if (dCmp(total, "0") <= 0) continue;
      grossWip.set(materialSkuId, dAdd(grossWip.get(materialSkuId) ?? "0", gw, 6));
      grossPlan.set(materialSkuId, dAdd(grossPlan.get(materialSkuId) ?? "0", gp, 6));
      const m = contribByMaterial.get(materialSkuId) ?? new Map<string, string>();
      m.set(pCode, dAdd(m.get(pCode) ?? "0", total, 6));
      contribByMaterial.set(materialSkuId, m);
      const productSet = contributingProductsByMaterial.get(materialSkuId) ?? new Set<number>();
      productSet.add(pid);
      contributingProductsByMaterial.set(materialSkuId, productSet);
    }
  }
  const materialIds = [...new Set([...grossWip.keys(), ...grossPlan.keys()])];
  if (materialIds.length === 0) {
    return empty({ wipWoCount, planSkuCount, missingBomProducts, bomIssues });
  }

  /* ── 物料主档 ── */
  const matRows: { id: number; code: string; name: string; baseUom: string }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, baseUom: schema.skus.baseUom })
    .from(schema.skus)
    .where(inArray(schema.skus.id, materialIds));
  const matById = new Map(matRows.map((m) => [m.id, m]));

  /* ── 在库：Σ stock_balances（物料口径；成品的快照仓/参考口径不适用） ── */
  const balRows: { skuId: number; qty: string | null }[] = await db
    .select({ skuId: schema.stockBalances.skuId, qty: sql<string | null>`sum(${schema.stockBalances.qty})` })
    .from(schema.stockBalances)
    .where(inArray(schema.stockBalances.skuId, materialIds))
    .groupBy(schema.stockBalances.skuId);
  const onHandBySku = new Map<number, string>(balRows.map((r) => [r.skuId, r.qty ?? "0"]));

  /* ── 供给：系统 PO 走 core/supply 唯一权威；旧包材台账走只读参考装配 ── */
  const [systemSupply, materialReferences] = await Promise.all([
    getOpenSupplyLines(db, materialIds),
    getMaterialReferenceLines(db, materialIds),
  ]);
  const poBySku = new Map<number, typeof systemSupply>();
  const inTransitBySku = new Map<number, string>();
  for (const line of systemSupply) {
    if (line.source !== "po") continue;
    const arr = poBySku.get(line.skuId) ?? [];
    arr.push(line);
    poBySku.set(line.skuId, arr);
    inTransitBySku.set(line.skuId, dAdd(inTransitBySku.get(line.skuId) ?? "0", String(line.qty), 6));
  }
  const refsBySku = new Map<number, typeof materialReferences>();
  for (const line of materialReferences) {
    const arr = refsBySku.get(line.materialSkuId) ?? [];
    arr.push(line);
    refsBySku.set(line.materialSkuId, arr);
  }

  /* ── MOQ/订货倍数：uom_convs 首行（按 id）兜底，值按基础单位解释（与 wo.ts/R11 同 PoC 口径） ── */
  const uomRows: { skuId: number; moq: string | null; orderMultiple: string | null }[] = await db
    .select({ skuId: schema.uomConvs.skuId, moq: schema.uomConvs.moq, orderMultiple: schema.uomConvs.orderMultiple })
    .from(schema.uomConvs)
    .where(inArray(schema.uomConvs.skuId, materialIds))
    .orderBy(asc(schema.uomConvs.id));
  const uomBySku = new Map<number, { moq: string | null; orderMultiple: string | null }>();
  for (const u of uomRows) if (!uomBySku.has(u.skuId)) uomBySku.set(u.skuId, u);

  /* ── 共用度：引用该物料的生效 BOM 成品数（全量，不限于本次有需求的成品；与 shared-packaging 同事实源） ── */
  const shareRows: { materialSkuId: number; cnt: number }[] = await db
    .select({
      materialSkuId: schema.bomLines.materialSkuId,
      cnt: sql<number>`count(distinct ${schema.boms.productSkuId})::int`,
    })
    .from(schema.bomLines)
    .innerJoin(schema.boms, and(eq(schema.bomLines.bomId, schema.boms.id), eq(schema.boms.status, "active")))
    .where(inArray(schema.bomLines.materialSkuId, materialIds))
    .groupBy(schema.bomLines.materialSkuId);
  const sharedBySku = new Map(shareRows.map((r) => [r.materialSkuId, r.cnt]));

  /* ── 逐物料净额化 ── */
  const all: MaterialDemandRow[] = [];
  let referenceMatchedLines = 0;
  let referenceAsOf: string | null = null;
  for (const mid of materialIds) {
    const m = matById.get(mid);
    if (!m) continue; // 主档缺失（理论上不可能，FK 保证）——跳过而非崩
    const fromWip = dQty(grossWip.get(mid) ?? "0");
    const fromPlan = dQty(grossPlan.get(mid) ?? "0");
    const grossReq = dQty(dAdd(fromWip, fromPlan, 6));
    const onHand = dQty(onHandBySku.get(mid) ?? "0");
    const inTransit = dQty(inTransitBySku.get(mid) ?? "0");
    const netReq = dQty(dMax(dSub(dSub(grossReq, onHand, 6), inTransit, 6), "0", 6));
    const uom = uomBySku.get(mid);
    const contrib = contribByMaterial.get(mid) ?? new Map<string, string>();
    const contributingProducts = contributingProductsByMaterial.get(mid) ?? new Set<number>();
    const references = refsBySku.get(mid) ?? [];
    const matchedReferences = references.filter(
      (line) => line.productSkuId != null && contributingProducts.has(line.productSkuId),
    );
    referenceMatchedLines += matchedReferences.length;
    for (const line of references) {
      if (referenceAsOf == null || line.asOf > referenceAsOf) referenceAsOf = line.asOf;
    }
    const referenceInTransit = dQty(
      matchedReferences
        .filter((line) => line.source === "legacy_pkg_order")
        .reduce((sum, line) => dAdd(sum, line.qty, 6), "0"),
    );
    const referenceReserved = dQty(
      matchedReferences
        .filter((line) => line.source === "legacy_pkg_stock")
        .reduce((sum, line) => dAdd(sum, line.qty, 6), "0"),
    );
    const referenceUnallocated = dQty(
      references
        .filter((line) => !matchedReferences.includes(line))
        .reduce((sum, line) => dAdd(sum, line.qty, 6), "0"),
    );
    const referenceAwareGap = dQty(
      dMax(dSub(dSub(netReq, referenceInTransit, 6), referenceReserved, 6), "0", 6),
    );
    const poLines = poBySku.get(mid) ?? [];
    const systemEta = earliestKitDate(
      [{
        materialSkuId: mid,
        required: grossReq,
        onHand,
        arrivals: poLines
          .filter((line) => line.expectDate != null)
          .map((line) => ({ date: line.expectDate!, qty: String(line.qty) })),
      }],
      today,
      horizonDays,
    ).kitDate;
    const referenceEta = matchedReferences.length > 0
      ? earliestKitDate(
        [{
          materialSkuId: mid,
          required: grossReq,
          onHand: dAdd(onHand, referenceReserved, 6),
          arrivals: [
            ...poLines
              .filter((line) => line.expectDate != null)
              .map((line) => ({ date: line.expectDate!, qty: String(line.qty) })),
            ...matchedReferences
              .filter((line) => line.source === "legacy_pkg_order" && line.expectDate != null)
              .map((line) => ({ date: line.expectDate!, qty: line.qty })),
          ],
        }],
        today,
        horizonDays,
      ).kitDate
      : null;
    all.push({
      materialSkuId: mid,
      code: m.code,
      name: m.name,
      baseUom: m.baseUom,
      grossReq,
      fromWip,
      fromPlan,
      onHand,
      inTransit,
      referenceInTransit,
      referenceReserved,
      referenceUnallocated,
      referenceAwareGap,
      systemEta,
      referenceEta,
      referenceEvidenceCount: matchedReferences.length,
      netReq,
      suggestQty: suggestQty({ grossReq, onHand, inTransit, moq: uom?.moq ?? null, orderMultiple: uom?.orderMultiple ?? null }),
      sharedCount: sharedBySku.get(mid) ?? 0,
      topProducts: [...contrib.entries()]
        .sort((a, b) => dCmp(b[1], a[1]) || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([code]) => code),
    });
  }

  /* ── 筛选 / 排序（净需求降序）/ 分页 ── */
  const filtered = q
    ? all.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
    : all;
  filtered.sort((a, b) => dCmp(b.netReq, a.netReq) || dCmp(b.grossReq, a.grossReq) || a.code.localeCompare(b.code));

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    summary: {
      materialCount: filtered.length,
      shortageCount: filtered.filter((r) => dCmp(r.netReq, "0") > 0).length,
      wipWoCount,
      planSkuCount,
      missingBomProducts: missingBomProducts.slice(0, 20),
      bomIssues: bomIssues.slice(0, 20),
      horizonDays,
      today,
      referenceMatchedLines,
      referenceMaterialCount: all.filter((row) => row.referenceEvidenceCount > 0).length,
      referenceAsOf,
    },
  };
}
