/**
 * R11 补货建议（成品维度，报表层）。
 *
 * 口径纪律：
 * - R13 doctrine：本页只呈现建议，不自动开单——「生成草稿」由人工点击（人工闸），产物为 BH 草稿走正常审批；
 * - 在库 = 全网口径（D20）：Σ stock_balances（实时账）+ 快照仓最新快照（latest-snapshot 模式与驾驶舱同口径，
 *   本地重实现，不 import report/dashboard.ts）；
 * - 在途 = 已审批/执行中 PO 实物行未收量（基础单位 = qty×uomFactor − receivedQty，逐行下限 0）。
 *   func#1：WO 在制产出已纳入全管道口径（wipQty，非建议驱动）；建议驱动仍为 PO 在途（保守）；
 * - 日均销 = 近3月销量 ÷ 91（窗口由 sales_monthly max(yearMonth) 动态回推，与驾驶舱同法，本地重推导）；
 * - 建议量 = R11 纯函数（rules/netreq.ts）：净需求 = 毛需求(日均×目标覆盖天数) − 在库 − 在途，
 *   MOQ/订货倍数取 uom_convs 首行（按 id）兜底——与 wo.ts 快照同一 PoC 口径（值按基础单位解释）；无行则纯净需求向上取整由 dQty 收口。
 * - 全表无金额字段，免脱敏。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { getNumParam } from "@/server/core/params";
import * as schema from "@/db/schema";
import { dAdd, dCmp, dDiv, dMul, dQty, dSub } from "@/server/core/decimal";
import { suggestQty } from "@/server/rules/netreq";
import { belowLeadtime, detectRefGap, fuseCover, shouldSuppressSuggest } from "@/server/rules/fusion";
import { forecastDaily } from "@/server/rules/forecast";
import { backtest } from "@/server/rules/backtest";
import { classifyAbc } from "@/server/rules/abc";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { createBh } from "@/server/modules/outsource/bh";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { todayShanghai } from "@/server/modules/master/common";
import { lastMonths } from "@/server/core/velocity";
import { getOnHandBySku } from "@/server/core/stock-view";
import { safetyStock } from "@/server/rules/safety-stock";
import { timePhasedNetReq } from "@/server/rules/timephased";
import { getOpenSupplyLines } from "@/server/core/supply";
import { makeResolver } from "@/server/core/scoped-params";
import { type AnyDb, num, r1, resolveDb } from "@/server/core/svc";
import { getSkuSupplyParams } from "@/server/modules/master/sku-supply-params";
import { salesWindow } from "@/server/core/sales-window";

export interface ReplenishRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  /** 全网在库（展示口径，1dp） */
  onHand: number;
  /** PO 在途（展示口径，1dp） */
  inTransit: number;
  /** 近3月日均销（1dp） */
  daily: number;
  /** 可销天数（1dp；日均=0 → null） */
  daysCover: number | null;
  /** R11 建议补货量（qty scale=4）；未触发预警为 null */
  suggestQty: string | null;
  /** 全口径参考在库（总库存明细文件，2026-07-21 时点；无参考 = null） */
  refQty: number | null;
  /** 在订未出（总库存明细「已下单未出货」；无参考 = null） */
  onOrder: number | null;
  /** 存量单在途（transit_refs fg_order 未入库余量，旧流程收尾口径） */
  legacyTransit: number;
  /** 在制委外产出（WO 计划产出，func#1；in_progress WO 残余部分批已收会高估，列注标明） */
  wipQty: number;
  /** 借出未还（func#20，从全管道扣减） */
  borrowOut: number;
  /** func#14 ABC 分层与生效目标覆盖天数 */
  abcClass: "A" | "B" | "C" | null;
  effectiveTarget: number;
  /** 常规生产周期（天，sku_leadtime staging；无 = null） */
  leadDays: number | null;
  /** 全管道可销天数（max(系统,参考)+全部在途 ÷ 日均；1dp） */
  coverFull: number | null;
  /** 覆盖缺口 SKU（参考显著>系统——海外/其他部门仓不在快照源） */
  refGap: boolean;
  /** 建议被抑制的原因（refGap 且全管道充足 → 防重复下单）；无抑制 = null */
  suppressReason: string | null;
  /** 可销天数已低于常规生产周期（补货窗口迫近） */
  belowLead: boolean;
  /** 被抑制时的「原始建议量」——人工核实覆盖缺口后可勾选放行（#2 修复） */
  heldQty: string | null;
  /** #2 预测日均（Holt 近6月，展示口径） */
  forecastDaily: number;
  /** 预测趋势 up/down/flat */
  forecastTrend: "up" | "down" | "flat";
  /** #13：预测与朴素日均显著分歧（>30%）——最值得人工复核的信号 */
  forecastDivergent: boolean;
  /** 该 SKU 的预测是否经回测证明优于朴素预测（否则预测列仅供参考，不发偏离告警） */
  forecastTrusted: boolean;
  /* ── E2-01/05 计划引擎 v2 ── */
  /** 安全库存（件） */
  safetyQty: number;
  /** 安全库存口径：statistical=统计法 / fallback=兜底天数 / none */
  safetyMethod: string;
  /** 首次跌破安全库存日；无短缺=null */
  shortageDate: string | null;
  /** 距短缺天数 */
  daysToShortage: number | null;
  /** 最晚下单日（短缺日−生产周期） */
  orderByDate: string | null;
  /** 已错过下单窗口 */
  orderWindowMissed: boolean;
  /** 建议量的逐步解释（可解释链） */
  planExplain: string[];
}

export interface ReplenishResult {
  rows: ReplenishRow[];
  total: number;
  meta: {
    coverDaysTarget: number;
    minCoverAlert: number;
    months3: string[];
    snapDate: string | null;
    /** 全部成品中触发建议的 SKU 数（不受分页影响） */
    suggestCount: number;
    /** 全口径参考时点（总库存明细 progress；无参考数据 = null） */
    refDate: string | null;
    /** 因覆盖缺口+全管道充足而被抑制的建议数 */
    suppressedCount: number;
    /** E2：建议引擎口径（time_phased=逐日推演触发；legacy=单桶覆盖天数） */
    engine: string;
    /** 目标服务水平（%） */
    serviceLevel: number;
  };
}

export interface ReplenishQuery {
  coverDaysTarget?: number;
  minCoverAlert?: number;
  q?: string;
  page?: number;
  pageSize?: number;
  /** 内部消费者（如 MRP 相关需求展开）取全量，绕过 API 分页夹取——防静默截断。HTTP 层永不传 true。 */
  allRows?: boolean;
}

export async function getReplenishSuggestions(query: ReplenishQuery, dbArg?: AnyDb): Promise<ReplenishResult> {
  const db = await resolveDb(dbArg);
  const userTarget = query.coverDaysTarget != null;
  const coverDaysTarget = Math.min(365, Math.max(1, Math.floor(query.coverDaysTarget ?? (await getNumParam("cover_target_days", 45, dbArg)))));
  const [targetA, targetB, targetC] = await Promise.all([
    getNumParam("cover_target_days_a", 60, dbArg),
    getNumParam("cover_target_days_b", 45, dbArg),
    getNumParam("cover_target_days_c", 25, dbArg),
  ]);
  const minCoverAlert = Math.min(365, Math.max(1, Math.floor(query.minCoverAlert ?? (await getNumParam("cover_alert_days", 30, dbArg)))));
  const page = Math.max(1, query.page ?? 1);
  const pageSize = query.allRows ? Number.MAX_SAFE_INTEGER : Math.min(999, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim();

  /* ── 成品 SKU（active） ── */
  const conds = [eq(schema.skus.skuType, "finished" as const), eq(schema.skus.active, true)];
  if (q) {
    conds.push(sql`(${schema.skus.code} ILIKE ${"%" + q + "%"} OR ${schema.skus.name} ILIKE ${"%" + q + "%"})`);
  }
  const skuRows: { id: number; code: string; name: string; baseUom: string; brand: string | null; brandId: number | null }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      baseUom: schema.skus.baseUom,
      brand: schema.brands.nameCn,
      brandId: schema.skus.brandId, // 分域参数 brand 层解析需要（缺它则 brand 覆盖永不命中）
    })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(and(...conds));
  if (skuRows.length === 0) {
    return { rows: [], total: 0, meta: { coverDaysTarget, minCoverAlert, months3: [], snapDate: null, suggestCount: 0, refDate: null, suppressedCount: 0, engine: "time_phased", serviceLevel: 95 } };
  }
  const skuIds = skuRows.map((s) => s.id);

  /* ── 在库：全网口径（core/stock-view 唯一实现） ── */
  const onHandView = await getOnHandBySku(db, { skuIds });
  const onHandBySku = onHandView.bySku;
  const snapDate: string | null = onHandView.snapDate;

  /* ── 在途：已审批/执行中 PO 未收量（基础单位，逐行下限 0；与 wo.ts 快照同口径） ── */
  const transitRows: { skuId: number; qty: string; uomFactor: string; receivedQty: string }[] = await db
    .select({
      skuId: schema.poLines.skuId,
      qty: schema.poLines.qty,
      uomFactor: schema.poLines.uomFactor,
      receivedQty: schema.poLines.receivedQty,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .where(and(inArray(schema.poLines.skuId, skuIds), inArray(schema.poDocs.status, ["approved", "in_progress"])));
  const inTransitBySku = new Map<number, string>();
  for (const r of transitRows) {
    const remain = dSub(dMul(r.qty, r.uomFactor, 6), r.receivedQty, 6);
    if (dCmp(remain, "0") <= 0) continue; // 超收行不抵扣其他行
    inTransitBySku.set(r.skuId, dAdd(inTransitBySku.get(r.skuId) ?? "0", remain, 6));
  }

  /* ── func#1 在制委外产出：WO（已审批/执行中、未暂停）计划产出——成品主要补给来源，
        原补货完全看不见导致重复下单。归入全管道口径（非建议驱动，同参考层纪律）。
        口径诚实：以 WO qty 计，未净部分批已收（in_progress WO 残余高估），列注标明。 ── */
  const woRows: { skuId: number; qty: string }[] = await db
    .select({ skuId: schema.woDocs.productSkuId, qty: schema.woDocs.qty })
    .from(schema.woDocs)
    .where(and(inArray(schema.woDocs.productSkuId, skuIds), inArray(schema.woDocs.status, ["approved", "in_progress"]), eq(schema.woDocs.isPaused, false)));
  const wipBySku = new Map<number, string>();
  for (const r of woRows) wipBySku.set(r.skuId, dAdd(wipBySku.get(r.skuId) ?? "0", r.qty, 6));

  /* ── func#20 借出未还：transit_refs kind=borrow orderType=借出——已借给其他渠道，从管道扣减 ── */
  const trB = schema.transitRefs;
  const borrowRows: { skuId: number | null; qty: string | null }[] = await db
    .select({ skuId: trB.skuId, qty: trB.qty })
    .from(trB)
    .where(and(eq(trB.kind, "borrow"), eq(trB.orderType, "借出"), inArray(trB.skuId, skuIds)));
  const borrowOutBySku = new Map<number, number>();
  for (const r of borrowRows) { if (r.skuId != null) borrowOutBySku.set(r.skuId, (borrowOutBySku.get(r.skuId) ?? 0) + num(r.qty)); }

  /* ── 销量矩阵：一次取回近 6 月 SKU×月（冗余#5：原分三次查 sales_monthly——
        近3月汇总 / ABC 全量 / 预测序列；其中近3月汇总与预测序列同窗同集，合并为一次），
        近3月汇总由矩阵按月 dAdd 精确累加（保持 decimal 字符串，不经 float）。 ── */
  const sm = schema.salesMonthly;
  const { maxYm } = await salesWindow(db);
  const months6 = maxYm ? lastMonths(maxYm, 6) : [];
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const months3Set = new Set(months3);
  const monthIdx = new Map(months6.map((m, i) => [m, i]));

  const sales3mBySku = new Map<number, string>();
  const seriesBySku = new Map<number, number[]>();
  if (months6.length) {
    const monthlyRows: { skuId: number; ym: string; qty: string | null }[] = await db
      .select({ skuId: sm.skuId, ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
      .from(sm)
      .where(and(inArray(sm.skuId, skuIds), inArray(sm.yearMonth, months6)))
      .groupBy(sm.skuId, sm.yearMonth);
    for (const r of monthlyRows) {
      const i = monthIdx.get(r.ym);
      if (i == null) continue;
      let arr = seriesBySku.get(r.skuId);
      if (!arr) { arr = new Array(months6.length).fill(0); seriesBySku.set(r.skuId, arr); }
      arr[i] = num(r.qty);
      if (months3Set.has(r.ym)) {
        sales3mBySku.set(r.skuId, dAdd(sales3mBySku.get(r.skuId) ?? "0", r.qty ?? "0", 6));
      }
    }
  }

  /* ── func#14 ABC 分层（全成品口径，与 q 过滤无关——故需独立一次全量查询）→ 逐 SKU 目标覆盖天数。
        窗口与「库存分层」页一致取近 6 月（同一 SKU 两页必须同类——曾因窗口不同产生 41 处分歧）。 ── */
  const abcBySku = new Map<number, "A" | "B" | "C">();
  if (months6.length) {
    const popRows: { skuId: number; qty: string | null }[] = await db
      .select({ skuId: sm.skuId, qty: sql<string | null>`sum(${sm.qty})` })
      .from(sm)
      .innerJoin(schema.skus, eq(sm.skuId, schema.skus.id))
      .where(and(eq(schema.skus.skuType, "finished"), eq(schema.skus.active, true), inArray(sm.yearMonth, months6)))
      .groupBy(sm.skuId);
    for (const [id, cls] of classifyAbc(popRows.map((r) => ({ id: r.skuId, qty: num(r.qty) })))) abcBySku.set(id, cls);
  }
  const targetForClass = (c: "A" | "B" | "C" | undefined): number =>
    userTarget ? coverDaysTarget : Math.min(365, Math.max(1, Math.floor(c === "A" ? targetA : c === "B" ? targetB : c === "C" ? targetC : coverDaysTarget)));

  /* ── 全口径参考：transit_refs kind=stock_summary（总库存明细，只参考不入账） ── */
  const tr = schema.transitRefs;
  const refRows: { skuId: number | null; qty: string | null; inboundQty: string | null; progress: string | null }[] = await db
    .select({ skuId: tr.skuId, qty: tr.qty, inboundQty: tr.inboundQty, progress: tr.progress })
    .from(tr)
    .where(and(eq(tr.kind, "stock_summary"), inArray(tr.skuId, skuIds)));
  const refBySku = new Map<number, { qty: number | null; onOrder: number | null }>();
  let refDate: string | null = null;
  for (const r of refRows) {
    if (r.skuId == null) continue;
    refBySku.set(r.skuId, { qty: r.qty == null ? null : num(r.qty), onOrder: r.inboundQty == null ? null : num(r.inboundQty) });
    if (r.progress && (refDate == null || r.progress > refDate)) refDate = r.progress;
  }

  /* ── 存量单在途：transit_refs kind=fg_order 未入库余量（旧流程收尾，登记口径） ── */
  const fgRows: { skuId: number | null; qty: string | null; inboundQty: string | null; closedQty: string | null }[] = await db
    .select({ skuId: tr.skuId, qty: tr.qty, inboundQty: tr.inboundQty, closedQty: tr.closedQty })
    .from(tr)
    .where(and(eq(tr.kind, "fg_order"), inArray(tr.skuId, skuIds)));
  const legacyBySku = new Map<number, number>();
  for (const r of fgRows) {
    if (r.skuId == null || r.qty == null) continue;
    const remain = num(r.qty) - num(r.inboundQty) - num(r.closedQty);
    if (remain <= 0) continue; // 已入库/已关单的存量单不再计在途
    legacyBySku.set(r.skuId, (legacyBySku.get(r.skuId) ?? 0) + remain);
  }

  /* ── 供应参数（生产周期 / MOQ / 订货倍数）：master/sku-supply-params 唯一读 facade，
        一次读齐，避免各服务分别 join uom_convs 与 sku_params（口径与顺序易漂移）。 ── */
  const supplyParams = await getSkuSupplyParams(skuIds, db);
  const leadBySkuId = new Map<number, number>();
  const uomBySku = new Map<number, { moq: string | null; orderMultiple: string | null }>();
  for (const [id, p] of supplyParams) {
    if (p.normalLeadDays != null && p.normalLeadDays > 0) leadBySkuId.set(id, p.normalLeadDays);
    uomBySku.set(id, { moq: p.moq, orderMultiple: p.orderMultiple });
  }

  /* ── E2-05：预取「有确认到货日」的未结供给（core/supply 唯一定义）供逐日推演 ── */
  const supplyLines = await getOpenSupplyLines(db, skuIds);
  const arrivalsBySku = new Map<number, { date: string; qty: number }[]>();
  for (const l of supplyLines) {
    if (!l.expectDate || l.qty <= 0) continue;
    const arr = arrivalsBySku.get(l.skuId) ?? [];
    arr.push({ date: l.expectDate, qty: l.qty });
    arrivalsBySku.set(l.skuId, arr);
  }

  /* ── E2-01+：交期波动（rollup_supplier_lead 物化结果）——此前因热路径开销未接入，
        E7-01 预聚合落地后改为一次批量读取，安全库存自此计入交期不确定性。
        同 SKU 多供应商时取样本最多的一条（最有代表性）。 ── */
  const leadStdevBySku = new Map<number, number>();
  {
    const rows: { skuId: number; stdev: string | null; samples: number }[] = await db
      .select({
        skuId: schema.rollupSupplierLead.skuId,
        stdev: schema.rollupSupplierLead.leadStdevDays,
        samples: schema.rollupSupplierLead.samples,
      })
      .from(schema.rollupSupplierLead)
      .where(inArray(schema.rollupSupplierLead.skuId, skuIds));
    const bestSamples = new Map<number, number>();
    for (const r of rows) {
      if (r.stdev == null) continue;
      const prev = bestSamples.get(r.skuId) ?? -1;
      if (r.samples > prev) {
        bestSamples.set(r.skuId, r.samples);
        leadStdevBySku.set(r.skuId, num(r.stdev));
      }
    }
  }

  /* ── E2-01：安全库存参数（服务水平/兜底天数），分域解析器（sku>brand>segment>global） ── */
  const serviceLevel = await getNumParam("service_level_pct", 95, dbArg);
  const resolveSafetyDays = await makeResolver("safety_days_fallback", 7, dbArg);
  const todayStr = todayShanghai();

  /* ── 逐 SKU 计算（decimal 计算、展示层 Number） ── */
  const all: (ReplenishRow & { _cover: number | null })[] = skuRows.map((s) => {
    const onHand = dQty(onHandBySku.get(s.id) ?? "0");
    const inTransit = dQty(inTransitBySku.get(s.id) ?? "0");
    const sales3m = sales3mBySku.get(s.id) ?? "0";
    const dailyDec = dCmp(sales3m, "0") > 0 ? dDiv(sales3m, "91", 6) : "0";
    const dailyNum = num(dailyDec);
    const cover = dailyNum > 0 ? (num(onHand) + num(inTransit)) / dailyNum : null;
    /* ── 预测与「预测偏离」告警 ──
       告警只在**该 SKU 的预测确有价值时**才发：先做滚动回测，若 Holt 的 WAPE 不优于
       朴素预测（下月＝上月），说明这条序列上模型本身就是噪声——此时「预测偏离日均」
       并不指示需求异常，只指示模型不适用（真实数据实测：441 个成品里 243 个如此，
       多为间歇性需求，Holt 本就不适配）。据此发警报＝制造告警疲劳。
       回测是纯计算（12 点序列，无 IO），不构成热路径开销。 ── */
    const series = seriesBySku.get(s.id) ?? [];
    const fc = forecastDaily(series);
    const fcBt = backtest(
      series.map((q, i) => ({ ym: String(i), qty: q })),
      (h) => { const r = forecastDaily(h); return r.forecastMonthly > 0 ? r.forecastMonthly : r.forecastDaily * 30.4; },
      3,
    );
    const forecastTrusted = fcBt.fva != null && fcBt.fva > 0;
    const forecastDivergent =
      forecastTrusted && dailyNum > 0 && fc.forecastDaily > 0 &&
      Math.abs(fc.forecastDaily - dailyNum) / dailyNum > 0.3;

    /* 全口径融合（rules/fusion.ts）：参考只调高在库认知，绝不调低 */
    const ref = refBySku.get(s.id);
    const legacyTransit = legacyBySku.get(s.id) ?? 0;
    const wipQty = num(wipBySku.get(s.id) ?? "0");
    const borrowOut = borrowOutBySku.get(s.id) ?? 0;
    const leadDays = leadBySkuId.get(s.id) ?? null; // sku_params 已转正（#18 兜底下线）
    const refGap = detectRefGap(num(onHand), ref?.qty ?? null);
    const coverFull = fuseCover({
      onHand: num(onHand),
      refQty: ref?.qty ?? null,
      inTransit: num(inTransit),
      legacyTransit,
      onOrder: ref?.onOrder ?? 0,
      wip: wipQty,
      borrowOut,
      daily: dailyNum,
    });

    const abcClass = abcBySku.get(s.id) ?? null;
    const effectiveTarget = targetForClass(abcClass ?? undefined);

    /* ── E2-01 安全库存：统计法（需求σ×交期），样本/交期不足降级兜底天数并注明 ── */
    /* 解析上下文必须带齐三层，缺一层则那一层的覆盖**永远不命中**：
       此前只传 {skuId, segment}，于是 /api/admin/params/scoped 写入的 brand 覆盖
       返 201、GET 列得出、审计也留痕，唯独建议量纹丝不动——写得进、读不到。
       （segment 传的是 ABC 单字母；九宫格 AX/BY 这类 cell 目前不在本引擎上下文里，
       要支持需先把 segmentation 的 cell 引进来，属另一件事，不在此处臆造。） */
    const safetyDays = resolveSafetyDays({
      skuId: s.id,
      brandId: s.brandId ?? undefined,
      segment: abcClass ?? undefined,
    });
    const ss = safetyStock({
      monthly: seriesBySku.get(s.id) ?? [],
      daily: dailyNum,
      leadDays,
      leadDaysStdev: leadStdevBySku.get(s.id) ?? 0, // 交期波动（无历史样本=0，退化为确定性交期）
      serviceLevel: String(serviceLevel),
      fallbackDays: safetyDays.value,
    });

    /* ── E2-05 时间分段净需求：逐日推演到首次跌破安全库存，替代「日均×覆盖天数」单桶乘法。
          触发＝再订货点逻辑：短缺发生在生产周期内（来不及补）才建议下单。 ── */
    const actionWindow = leadDays != null && leadDays > 0 ? leadDays : minCoverAlert;
    const tp = timePhasedNetReq({
      today: todayStr,
      onHand: num(onHand),
      daily: dailyNum,
      arrivals: arrivalsBySku.get(s.id) ?? [],
      safetyQty: ss.safetyQty,
      coverTargetDays: effectiveTarget,
      leadDays,
      horizonDays: Math.min(365, actionWindow + effectiveTarget + 30),
    });

    let suggest: string | null = null;
    let heldQty: string | null = null;
    let suppressReason: string | null = null;
    const planExplain: string[] = [`安全库存 ${ss.safetyQty}（${ss.reason}）`, ...tp.explain];
    const triggered = tp.shortageDate != null && tp.daysToShortage != null && tp.daysToShortage <= actionWindow;
    if (triggered && tp.requiredQty > 0) {
      const uom = uomBySku.get(s.id);
      // 净需求已由逐日推演得出；此处仅施加 MOQ/订货倍数（onHand/inTransit 已在推演中扣除，故传 0）
      const suggested = suggestQty({
        grossReq: String(tp.requiredQty),
        onHand: "0",
        inTransit: "0",
        moq: uom?.moq ?? null,
        orderMultiple: uom?.orderMultiple ?? null,
      });
      planExplain.push(`施加 MOQ/订货倍数后 → ${suggested}`);
      /* 抑制基准必须与**触发**基准同源（2026-07-26 红队实证）。
         触发用 actionWindow（=生产周期，本仓 40–68 天，见 :405/:421），
         而抑制此前仍用 minCoverAlert(=cover_alert_days 缺省 30)。
         二者不一致时，凡系统可销落在 30–生产周期之间的 SKU，
         shouldSuppressSuggest 的第一个条件 coverSystem < 基准 恒不成立 → **闸门结构性打不开**：
         实测 37/80 条建议（46%）不可抑制，其中 18 条按同源基准本应抑制、合计 115,391 件，
         等于对海外/其他部门仓已有的货重复下单。
         抑制≠拦单：被抑制的量仍以 heldQty 保留、逐行给出原因，人工核实后可手工放行。 */
      if (shouldSuppressSuggest(cover, coverFull, actionWindow, refGap)) {
        suppressReason = "全口径参考充足（覆盖缺口 SKU：海外/其他部门仓不在系统快照源）——请先核实全口径库存，防重复下单";
        if (dCmp(suggested, "0") > 0) heldQty = suggested;
      } else if (dCmp(suggested, "0") > 0) {
        suggest = suggested;
      }
    } else if (tp.shortageDate != null) {
      planExplain.push(`短缺在 ${tp.daysToShortage} 天后、超出行动窗口 ${actionWindow} 天（生产周期内可补），暂不建议下单`);
    }
    return {
      skuId: s.id,
      code: s.code,
      name: s.name,
      brand: s.brand,
      baseUom: s.baseUom,
      onHand: r1(num(onHand)),
      inTransit: r1(num(inTransit)),
      daily: r1(dailyNum),
      daysCover: cover == null ? null : r1(cover),
      suggestQty: suggest,
      refQty: ref?.qty == null ? null : r1(ref.qty),
      onOrder: ref?.onOrder == null ? null : r1(ref.onOrder),
      legacyTransit: r1(legacyTransit),
      wipQty: r1(wipQty),
      borrowOut: r1(borrowOut),
      abcClass,
      effectiveTarget,
      leadDays,
      coverFull: coverFull == null ? null : r1(coverFull),
      refGap,
      suppressReason,
      belowLead: belowLeadtime(cover, leadDays),
      heldQty,
      forecastDaily: fc.forecastDaily,
      forecastTrend: fc.trend,
      forecastDivergent,
      forecastTrusted,
      safetyQty: ss.safetyQty,
      safetyMethod: ss.method,
      shortageDate: tp.shortageDate,
      daysToShortage: tp.daysToShortage,
      orderByDate: tp.orderByDate,
      orderWindowMissed: tp.orderWindowMissed,
      planExplain,
      _cover: coverFull ?? cover, // #1 修复：排序用全管道口径——覆盖缺口误报不再霸榜
    };
  });

  // 可销天数升序（越紧急越靠前）；无动销（daily=0）排最后，再按编码稳定排序
  all.sort((a, b) => {
    if (a._cover == null && b._cover == null) return a.code.localeCompare(b.code);
    if (a._cover == null) return 1;
    if (b._cover == null) return -1;
    return a._cover - b._cover || a.code.localeCompare(b.code);
  });
  const suggestCount = all.filter((r) => r.suggestQty != null).length;
  const suppressedCount = all.filter((r) => r.suppressReason != null).length;
  const rows: ReplenishRow[] = all.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
    skuId: r.skuId,
    code: r.code,
    name: r.name,
    brand: r.brand,
    baseUom: r.baseUom,
    onHand: r.onHand,
    inTransit: r.inTransit,
    daily: r.daily,
    daysCover: r.daysCover,
    suggestQty: r.suggestQty,
    refQty: r.refQty,
    onOrder: r.onOrder,
    legacyTransit: r.legacyTransit,
    wipQty: r.wipQty,
    borrowOut: r.borrowOut,
    abcClass: r.abcClass,
    effectiveTarget: r.effectiveTarget,
    leadDays: r.leadDays,
    coverFull: r.coverFull,
    refGap: r.refGap,
    suppressReason: r.suppressReason,
    belowLead: r.belowLead,
    heldQty: r.heldQty,
    forecastDaily: r.forecastDaily,
    forecastTrend: r.forecastTrend,
    safetyQty: r.safetyQty,
    safetyMethod: r.safetyMethod,
    shortageDate: r.shortageDate,
    daysToShortage: r.daysToShortage,
    orderByDate: r.orderByDate,
    orderWindowMissed: r.orderWindowMissed,
    planExplain: r.planExplain,
    forecastDivergent: r.forecastDivergent,
    forecastTrusted: r.forecastTrusted,
  }));
  return { rows, total: all.length, meta: { coverDaysTarget, minCoverAlert, months3, snapDate, suggestCount, refDate, suppressedCount, engine: "time_phased", serviceLevel } };
}

/* ────────────────────────── 生成 BH 草稿（R13 人工闸） ────────────────────────── */

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字")
  .refine((s) => dCmp(s, "0") > 0, "数量必须大于 0");

export const createReplenishDraftSchema = z.object({
  remark: z.string().trim().max(500).optional(),
  items: z
    .array(z.object({ skuId: z.number().int().positive({ message: "必须选择 SKU" }), qty: decStr }))
    .min(1, "至少选择一项建议")
    .max(200, "一次最多 200 项"),
});
export type CreateReplenishDraftInput = z.infer<typeof createReplenishDraftSchema>;

/**
 * 将勾选的补货建议生成 ONE 张 BH 备货申请草稿（复用 outsource/bh.createBh，走正常审批流）。
 * 权限：pmc（admin 兜底）——本函数即人工闸的授权边界；createBh 内的 ops 门针对 BH 直录路径，
 * 故以补充 ops 角色的委托身份调用（审计仍记真实 userId，另落 replenish 来源审计）。
 */
export async function createReplenishDraft(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ id: number; docNo: string }> {
  requireAnyRole(user, "pmc");
  const v = createReplenishDraftSchema.parse(input);
  const db = await resolveDb(dbArg);

  const delegate: SessionUser = user.roles.includes("ops")
    ? user
    : { ...user, roles: [...user.roles, "ops"] };
  const doc = await createBh(
    delegate,
    {
      remark: v.remark?.trim() ? v.remark.trim() : "由补货建议页生成（R11，人工确认）",
      lines: v.items.map((i) => ({ skuId: i.skuId, qty: i.qty })),
    },
    db,
  );
  // createBh 内已按 bh 实体留痕；此处补一条来源审计（replenish → bh）
  await writeAudit(db, {
    userId: user.id,
    entity: "replenish",
    entityId: doc.id,
    action: "draft_bh",
    after: { docNo: doc.docNo, lineCount: v.items.length, source: "replenish_suggestion" },
  });
  return { id: doc.id, docNo: doc.docNo };
}
