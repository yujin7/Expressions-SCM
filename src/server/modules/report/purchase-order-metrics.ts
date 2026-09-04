/**
 * D63 采购订单指标读模型 `purchase-order-metrics/v3`（真报表 + 驾驶舱第 2 屏「订单系统 / 成本下降」卡）。
 *
 * v2（B5 口径变更）：byMonth 增加逐月 OTIF（按 PO 下单月归期，与年度累计同一判定），
 * 驾驶舱 PO 趋势块改用逐月 OTIF 而非年度累计——键随口径升版，旧缓存自然失效。
 *
 * v3（W2 审计 1，OTIF 反洗白）：准时判定的**主口径改为原始承诺**（po_promise_revisions 里
 * 第一条可信修订的承诺日；口径唯一权威 `rules/promise-basis.ts`），当前承诺降为**并列副口径**
 * （`otifCurrent`）。此前两个口径合一，供应商经确认门户把交期往后改一次，自己的 OTIF 就变好看——
 * 改期越勤分数越高。两个口径都必须带标签展示（`otifBasisLabel` / `otifSecondaryBasisLabel`），
 * 并带版本链覆盖 `promiseHistory`：没有可信版本链的行，「原始承诺」其实是回落的当前承诺，
 * 不能让读者以为全量都按原始承诺判过。
 *
 * 口径（D63，参数在 PARAM_DEFS）：
 * - 已下单时点 = PO **审批通过**（approvals doc_type=po action=approve 的最后一次），不是制单；
 *   草稿/待审/驳回/作废不算；短关（closed）算已下单（下过单是事实）。
 * - 金额 = 采购订单口径（非应付）：**未税为主、含税并列**，按行 price × qty 去税/补税（税率取行上 taxRatePct）。
 * - 数量 = 基础单位（qty × uomFactor）。
 * - 订单至交付：`rules/po-cycle.ts`（审批 → 首批生效 SH；全收并列：Σ已收 ≥ Σ应收 × (1 − otif_qty_tolerance_pct%) 时取最后一张 SH，
 *   与 OTIF 足量判定同一口径）；P50/P90 样本 < 3 标样本不足。
 * - 降本：`rules/cost-saving.ts`；基线 = **上一年度**已批数量加权基础单位未税均价（按 SKU，跨供应商），
 *   上一年度无则取该 SKU 首个已批行价；只计降价，涨价另列不轧差。
 * - 供应商 OTIF：**主口径承诺日 = 原始承诺**（min(该行第一条可信修订承诺日；无版本链回落当前承诺））；
 *   并列副口径 otifCurrent 用当前承诺 min(coalesce(行交期, 表头交期))；准时 = 全收完成日 ≤ 承诺日 + otif_window_days；
 *   足量 = Σ已收 ≥ Σ应收 × (1 − otif_qty_tolerance_pct%)；缺承诺日进「不可评」桶；未到期且未收齐进「待评」桶。
 * - 月桶：只取统计年 `${year}-01` 至当前月（历史年份到 12 月），缺月为 0 单（「没下单」是事实，不是缺数据）。
 * - 缓存：report_read_model_cache，source_binding 绑 po_docs / sh_docs / approvals max(id)+行数 + sys_params 里
 *   otif_window_days / otif_qty_tolerance_pct 当前值（改口径即失效重算）；
 *   状态类变化（作废/短关）不改 id，故由每日任务 refreshPurchaseOrderMetrics 兜底重建。
 * - 金额只对 PRICE_VISIBLE_ROLES 可见：路由经 stripPurchaseOrderMoney 剥离（单数/数量全员可见）。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getDbAsync } from "@/db";
import { type Dec, dAdd, dCmp, dDiv, dMul, dQty } from "@/server/core/decimal";
import { canSeePrices } from "@/server/core/dto";
import { getNumParam } from "@/server/core/params";
import { type AnyDb } from "@/server/core/svc";
import { costSaving } from "@/server/rules/cost-saving";
import { orderToDeliveryDays, shanghaiDay } from "@/server/rules/po-cycle";
import { normalizeLineNetGross, normalizeToBaseNet } from "@/server/rules/price";
import {
  countPromiseHistory, emptyPromiseHistoryCoverage, PROMISE_BASIS_LABELS,
  promiseDateForBasis, resolvePromiseBasis,
  type PromiseBasis, type PromiseBasisFact, type PromiseHistoryCoverage,
} from "@/server/rules/promise-basis";

export const PURCHASE_ORDER_METRICS_KEY = "purchase-order-metrics/v3";
/** 「已下单」的 PO 状态（审批通过后的全部形态；void 不算） */
export const ORDERED_PO_STATUSES = ["approved", "in_progress", "completed", "closed"] as const;
/** 生效收货状态（照抄 report/wip.ts ACTIVE_SH_STATUSES） */
const ACTIVE_SH_STATUSES = ["approved", "in_progress", "completed"] as const;
/** P50/P90 最小样本数（计划 PO-R7） */
export const MIN_CYCLE_SAMPLES = 3;
/** OTIF 主口径（v3 起）：原始承诺；当前承诺降为并列副口径 */
export const OTIF_PRIMARY_BASIS: PromiseBasis = "original";
export const OTIF_SECONDARY_BASIS: PromiseBasis = "current";
export const OTIF_PRIMARY_BASIS_LABEL = PROMISE_BASIS_LABELS[OTIF_PRIMARY_BASIS];
export const OTIF_SECONDARY_BASIS_LABEL = PROMISE_BASIS_LABELS[OTIF_SECONDARY_BASIS];

export interface PoVolume {
  poCount: number;
  lineCount: number;
  /** 基础单位数量（scale 4） */
  orderedBaseQty: string;
  /** 未税金额（scale 2；无权限 → null） */
  netAmount: string | null;
  /** 含税金额（scale 2；无权限 → null） */
  grossAmount: string | null;
}

export interface CycleStats {
  n: number;
  firstP50: number | null;
  firstP90: number | null;
  nFull: number;
  fullP50: number | null;
  fullP90: number | null;
  /** n < MIN_CYCLE_SAMPLES */
  insufficient: boolean;
}

export interface OtifStats {
  evaluable: number;
  hit: number;
  miss: number;
  /** 未到承诺日+窗口且未收齐 */
  pending: number;
  /** 缺承诺交期 */
  unevaluable: number;
  /** hit / evaluable（0–1，4 位小数）；evaluable=0 → null */
  rate: number | null;
}

export interface CostSavingStats {
  savingYtd: string | null;
  increaseYtd: string | null;
  comparableLines: number;
  nonComparableLines: number;
}

export interface PoMonthRow extends PoVolume {
  month: string;
  /** 逐月 OTIF（v2）：按 PO 下单月（审批通过月）归期，判定与年度累计完全同口径；v3 起为**原始承诺**口径 */
  otif: OtifStats;
  /** 并列副口径：当前承诺（供应商改期后的值）——与 otif 一起看才知道改期吃掉了多少迟到 */
  otifCurrent: OtifStats;
}

export interface PoSupplierRow extends PoVolume {
  supplierId: number;
  code: string;
  name: string;
  cycle: CycleStats;
  /** 原始承诺口径（主） */
  otif: OtifStats;
  /** 当前承诺口径（副） */
  otifCurrent: OtifStats;
  costSaving: CostSavingStats;
}

export interface PoBrandRow extends PoVolume {
  brandId: number | null;
  brandCode: string | null;
  brandName: string;
}

export interface PurchaseOrderMetrics {
  key: typeof PURCHASE_ORDER_METRICS_KEY;
  authority: "ledger";
  sourceBinding: string;
  builtAt: string;
  asOf: string;
  year: number;
  month: string;
  baselineYear: number;
  moneyVisible: boolean;
  params: { otifWindowDays: number; otifQtyTolerancePct: number; minCycleSamples: number };
  /** OTIF 主口径标识与标签（v3：原始承诺为主、当前承诺为辅，两者必须同时展示） */
  otifBasis: PromiseBasis;
  otifBasisLabel: string;
  otifSecondaryBasis: PromiseBasis;
  otifSecondaryBasisLabel: string;
  /** 承诺版本链覆盖（按 PO 行计）：missing/backfilled 行的「原始承诺」其实是回落的当前承诺 */
  promiseHistory: PromiseHistoryCoverage;
  summary: {
    thisMonth: PoVolume;
    ytd: PoVolume;
    cycle: CycleStats;
    otif: OtifStats;
    otifCurrent: OtifStats;
    costSaving: CostSavingStats;
    /** 因换算系数非法等被剔除的行数 */
    invalidLines: number;
    /** 全部已下单 PO（不限年份）张数，供覆盖说明 */
    orderedPoAllTime: number;
  };
  byMonth: PoMonthRow[];
  bySupplier: PoSupplierRow[];
  byBrand: PoBrandRow[];
  limitations: string[];
}

/* ───────────────────────── 内部结构 ───────────────────────── */

interface LineFact {
  poId: number;
  skuId: number;
  brandId: number | null;
  brandCode: string | null;
  brandName: string | null;
  baseQty: string;
  receivedQty: string;
  unitBaseNet: string;
  netAmount: string;
  grossAmount: string;
  /** 当前承诺（行交期；空则由 PoFact 表头兜底） */
  expectedDate: string | null;
  /** 该行承诺版本链事实（原始承诺 / 可信度 / 改期次数） */
  promise: PromiseBasisFact;
}

interface PoFact {
  poId: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  status: string;
  orderedAt: Date | string;
  orderedDay: string;
  month: string;
  year: number;
  expectedDate: string | null;
  firstReceiptAt: Date | string | null;
  lastReceiptAt: Date | string | null;
  lines: LineFact[];
}

function emptyVolume(): PoVolume {
  return { poCount: 0, lineCount: 0, orderedBaseQty: "0.0000", netAmount: "0.00", grossAmount: "0.00" };
}

function addVolume(acc: PoVolume, line: LineFact): void {
  acc.lineCount += 1;
  acc.orderedBaseQty = dAdd(acc.orderedBaseQty, line.baseQty, 4);
  acc.netAmount = dAdd(acc.netAmount ?? "0", line.netAmount, 2);
  acc.grossAmount = dAdd(acc.grossAmount ?? "0", line.grossAmount, 2);
}

/** 最近名次法百分位（样本为整数天） */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function cycleStats(first: number[], full: number[]): CycleStats {
  const a = [...first].sort((x, y) => x - y);
  const b = [...full].sort((x, y) => x - y);
  const insufficient = a.length < MIN_CYCLE_SAMPLES;
  return {
    n: a.length,
    firstP50: insufficient ? null : percentile(a, 50),
    firstP90: insufficient ? null : percentile(a, 90),
    nFull: b.length,
    fullP50: b.length < MIN_CYCLE_SAMPLES ? null : percentile(b, 50),
    fullP90: b.length < MIN_CYCLE_SAMPLES ? null : percentile(b, 90),
    insufficient,
  };
}

function emptyOtif(): OtifStats {
  return { evaluable: 0, hit: 0, miss: 0, pending: 0, unevaluable: 0, rate: null };
}

function finishOtif(o: OtifStats): OtifStats {
  o.evaluable = o.hit + o.miss;
  o.rate = o.evaluable === 0 ? null : Math.round((o.hit / o.evaluable) * 10_000) / 10_000;
  return o;
}

function emptySaving(): CostSavingStats {
  return { savingYtd: "0.00", increaseYtd: "0.00", comparableLines: 0, nonComparableLines: 0 };
}

function addDays(day: string, days: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 承诺日（按口径）：min(逐行承诺日)；全缺 → 表头承诺日。
 * - current  = coalesce(行交期, 表头交期)（供应商改期后的当前值）
 * - original = 该行第一条可信修订的承诺日；无可信版本链回落 current（回落量由 promiseHistory 披露）
 */
function promisedDate(po: PoFact, basis: PromiseBasis): string | null {
  let min: string | null = null;
  for (const line of po.lines) {
    const current = line.expectedDate ?? po.expectedDate;
    const d = promiseDateForBasis(basis, line.promise, current);
    if (d && (min == null || d < min)) min = d;
  }
  return min ?? po.expectedDate;
}

export type OtifOutcome = "hit" | "miss" | "pending" | "unevaluable";

export interface OtifParams {
  windowDays: number;
  qtyTolerancePct: number;
}

/**
 * 「全收」判定（OTIF 足量与全收周期共用同一口径）：
 * Σ已收 ≥ Σ应收 × (1 − otif_qty_tolerance_pct/100)，应收 ≤ 0 不算全收。导出供测试直测。
 */
export function isFullReceipt(orderedBaseQty: Dec, receivedBaseQty: Dec, qtyTolerancePct: number): boolean {
  if (dCmp(orderedBaseQty, 0) <= 0) return false;
  const required = dMul(orderedBaseQty, dSubPct(qtyTolerancePct), 4);
  return dCmp(receivedBaseQty, required) >= 0;
}

/** 单张 PO 的 OTIF 判定（导出供测试直测） */
export function evaluateOtif(
  input: {
    promised: string | null;
    orderedBaseQty: Dec;
    receivedBaseQty: Dec;
    lastReceiptDay: string | null;
    today: string;
  },
  params: OtifParams,
): OtifOutcome {
  if (!input.promised) return "unevaluable";
  const deadline = addDays(input.promised, params.windowDays);
  const full = isFullReceipt(input.orderedBaseQty, input.receivedBaseQty, params.qtyTolerancePct);
  if (full) return input.lastReceiptDay != null && input.lastReceiptDay <= deadline ? "hit" : "miss";
  return input.today > deadline ? "miss" : "pending";
}

function dSubPct(pct: number): string {
  return dDiv(100 - pct, 100, 6);
}

/** OTIF 参数（sys_params，PARAM_DEFS 已登记；测试传 db 走实时不走缓存） */
async function readOtifParams(db: AnyDb): Promise<OtifParams> {
  const [windowDays, qtyTolerancePct] = await Promise.all([
    getNumParam("otif_window_days", 2, db),
    getNumParam("otif_qty_tolerance_pct", 0, db),
  ]);
  return { windowDays, qtyTolerancePct };
}

/* ───────────────────────── 取数 ───────────────────────── */

/**
 * 绑定：三张事实表 max(id)+行数 + **承诺版本链** max(id)+行数 + 统计年 + OTIF 口径参数。
 * v3 起承诺版本链参与判定：供应商改期只写 po_promise_revisions（不改 po_docs.id），
 * 不把它绑进来，改期后缓存不会失效、原始承诺口径就永远读旧值。
 */
async function sourceBinding(db: AnyDb, year: number, otif: OtifParams): Promise<string> {
  const [po] = await db
    .select({ maxId: sql<number>`coalesce(max(${schema.poDocs.id}), 0)::int`, n: sql<number>`count(*)::int` })
    .from(schema.poDocs);
  const [sh] = await db
    .select({ maxId: sql<number>`coalesce(max(${schema.shDocs.id}), 0)::int`, n: sql<number>`count(*)::int` })
    .from(schema.shDocs);
  const [ap] = await db
    .select({ maxId: sql<number>`coalesce(max(${schema.approvals.id}), 0)::int` })
    .from(schema.approvals)
    .where(eq(schema.approvals.docType, "po"));
  const [pr] = await db
    .select({ maxId: sql<number>`coalesce(max(${schema.poPromiseRevisions.id}), 0)::int`, n: sql<number>`count(*)::int` })
    .from(schema.poPromiseRevisions);
  return `po:${po.maxId}/${po.n}|sh:${sh.maxId}/${sh.n}|appr:${ap.maxId}|promise:${pr.maxId}/${pr.n}`
    + `|year:${year}|otif:${otif.windowDays}/${otif.qtyTolerancePct}`;
}

async function loadFacts(db: AnyDb): Promise<{ pos: PoFact[]; invalidLines: number }> {
  const ordered: { docId: number; orderedAt: Date | string }[] = await db
    .select({ docId: schema.approvals.docId, orderedAt: sql<Date | string>`max(${schema.approvals.createdAt})` })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.docType, "po"), eq(schema.approvals.action, "approve")))
    .groupBy(schema.approvals.docId);
  const orderedAtByPo = new Map<number, Date | string>(ordered.map((r) => [r.docId, r.orderedAt]));
  if (orderedAtByPo.size === 0) return { pos: [], invalidLines: 0 };

  const docs: {
    id: number; status: string; supplierId: number; supplierCode: string; supplierName: string; expectedDate: string | null;
  }[] = await db
    .select({
      id: schema.poDocs.id,
      status: schema.poDocs.status,
      supplierId: schema.poDocs.supplierId,
      supplierCode: schema.suppliers.code,
      supplierName: schema.suppliers.name,
      expectedDate: schema.poDocs.expectedDate,
    })
    .from(schema.poDocs)
    .innerJoin(schema.suppliers, eq(schema.poDocs.supplierId, schema.suppliers.id))
    .where(inArray(schema.poDocs.status, [...ORDERED_PO_STATUSES]));

  const receipts: { poId: number; firstAt: Date | string; lastAt: Date | string }[] = await db
    .select({
      poId: schema.shDocs.sourceId,
      firstAt: sql<Date | string>`min(${schema.shDocs.createdAt})`,
      lastAt: sql<Date | string>`max(${schema.shDocs.createdAt})`,
    })
    .from(schema.shDocs)
    .where(and(eq(schema.shDocs.sourceType, "po"), inArray(schema.shDocs.status, [...ACTIVE_SH_STATUSES])))
    .groupBy(schema.shDocs.sourceId);
  const receiptByPo = new Map(receipts.map((r) => [r.poId, r]));

  const lines: {
    lineId: number; poId: number; skuId: number; qty: string; uomFactor: string; price: string; taxIncluded: boolean; taxRatePct: string;
    receivedQty: string; expectedDate: string | null; brandId: number | null; brandCode: string | null; brandName: string | null;
  }[] = await db
    .select({
      lineId: schema.poLines.id,
      poId: schema.poLines.poId,
      skuId: schema.poLines.skuId,
      qty: schema.poLines.qty,
      uomFactor: schema.poLines.uomFactor,
      price: schema.poLines.price,
      taxIncluded: schema.poLines.taxIncluded,
      taxRatePct: schema.poLines.taxRatePct,
      receivedQty: schema.poLines.receivedQty,
      expectedDate: schema.poLines.expectedDate,
      brandId: schema.skus.brandId,
      brandCode: schema.brands.code,
      brandName: schema.brands.nameCn,
    })
    .from(schema.poLines)
    .innerJoin(schema.skus, eq(schema.poLines.skuId, schema.skus.id))
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .orderBy(schema.poLines.poId, schema.poLines.id);

  /* 承诺版本链（v3）：逐行取原始承诺；口径实现只有 rules/promise-basis.ts 一处 */
  const revisionRows: { poLineId: number; sequence: number; promisedDate: string | null; source: string }[] = await db
    .select({
      poLineId: schema.poPromiseRevisions.poLineId,
      sequence: schema.poPromiseRevisions.sequence,
      promisedDate: schema.poPromiseRevisions.promisedDate,
      source: schema.poPromiseRevisions.source,
    })
    .from(schema.poPromiseRevisions)
    .orderBy(schema.poPromiseRevisions.poLineId, schema.poPromiseRevisions.sequence);
  const revisionsByLine = new Map<number, typeof revisionRows>();
  for (const r of revisionRows) {
    const list = revisionsByLine.get(r.poLineId) ?? [];
    list.push(r);
    revisionsByLine.set(r.poLineId, list);
  }

  const pos = new Map<number, PoFact>();
  for (const d of docs) {
    const orderedAt = orderedAtByPo.get(d.id);
    if (!orderedAt) continue; // 状态已批但无审批记录（seed/迁移数据）：无「下单时点」，不猜
    const day = shanghaiDay(orderedAt);
    if (!day) continue;
    const r = receiptByPo.get(d.id);
    pos.set(d.id, {
      poId: d.id,
      supplierId: d.supplierId,
      supplierCode: d.supplierCode,
      supplierName: d.supplierName,
      status: d.status,
      orderedAt,
      orderedDay: day,
      month: day.slice(0, 7),
      year: Number(day.slice(0, 4)),
      expectedDate: d.expectedDate,
      firstReceiptAt: r?.firstAt ?? null,
      lastReceiptAt: r?.lastAt ?? null,
      lines: [],
    });
  }

  let invalidLines = 0;
  for (const l of lines) {
    const po = pos.get(l.poId);
    if (!po) continue;
    let unitBaseNet: string;
    try {
      unitBaseNet = normalizeToBaseNet({ price: l.price, taxIncluded: l.taxIncluded, taxRatePct: l.taxRatePct, uomFactor: l.uomFactor });
    } catch {
      invalidLines += 1;
      continue;
    }
    const { net: netAmount, gross: grossAmount } = normalizeLineNetGross({ price: l.price, qty: l.qty, taxIncluded: l.taxIncluded, taxRatePct: l.taxRatePct });
    po.lines.push({
      poId: l.poId,
      skuId: l.skuId,
      brandId: l.brandId,
      brandCode: l.brandCode,
      brandName: l.brandName,
      baseQty: dMul(l.qty, l.uomFactor, 4),
      receivedQty: dQty(l.receivedQty ?? "0"),
      unitBaseNet,
      netAmount,
      grossAmount,
      expectedDate: l.expectedDate,
      promise: resolvePromiseBasis(revisionsByLine.get(l.lineId) ?? []),
    });
  }
  return { pos: [...pos.values()].sort((a, b) => a.poId - b.poId), invalidLines };
}

/* ───────────────────────── 计算 ───────────────────────── */

export interface ComputeOptions {
  /** 统计年份（默认 asOf 的上海年份） */
  year?: number;
  asOf?: Date;
}

export async function computePurchaseOrderMetrics(db: AnyDb, opts: ComputeOptions = {}): Promise<PurchaseOrderMetrics> {
  const asOfDate = opts.asOf ?? new Date();
  const today = shanghaiDay(asOfDate)!;
  const year = opts.year ?? Number(today.slice(0, 4));
  const isCurrentYear = year === Number(today.slice(0, 4));
  const month = isCurrentYear ? today.slice(0, 7) : `${year}-12`;
  const baselineYear = year - 1;
  const otifParams = await readOtifParams(db);
  const { windowDays: otifWindowDays, qtyTolerancePct: otifQtyTolerancePct } = otifParams;

  const { pos, invalidLines } = await loadFacts(db);
  const inYear = pos.filter((p) => p.year === year);

  /* 基线：上一年度已批行 按 SKU 数量加权基础单位未税均价；无则该 SKU 首个已批行价 */
  const baseline = new Map<number, string>();
  {
    const sumQty = new Map<number, string>();
    const sumAmt = new Map<number, string>();
    for (const po of pos.filter((p) => p.year === baselineYear)) {
      for (const line of po.lines) {
        if (dCmp(line.baseQty, 0) <= 0) continue;
        sumQty.set(line.skuId, dAdd(sumQty.get(line.skuId) ?? "0", line.baseQty, 4));
        sumAmt.set(line.skuId, dAdd(sumAmt.get(line.skuId) ?? "0", dMul(line.unitBaseNet, line.baseQty, 6), 6));
      }
    }
    for (const [skuId, qty] of sumQty) baseline.set(skuId, dDiv(sumAmt.get(skuId)!, qty, 4));
    // 首个已批行（按下单日、PO id 顺序）
    const ordered = [...pos].sort((a, b) => (a.orderedDay < b.orderedDay ? -1 : a.orderedDay > b.orderedDay ? 1 : a.poId - b.poId));
    for (const po of ordered) {
      for (const line of po.lines) {
        if (!baseline.has(line.skuId)) baseline.set(line.skuId, line.unitBaseNet);
      }
    }
  }

  const thisMonth = emptyVolume();
  const ytd = emptyVolume();
  const byMonth = new Map<string, PoMonthRow>();
  const bySupplier = new Map<number, PoSupplierRow & { firstDays: number[]; fullDays: number[] }>();
  const byBrand = new Map<string, PoBrandRow>();
  const firstDaysAll: number[] = [];
  const fullDaysAll: number[] = [];
  const otifAll = emptyOtif();
  const otifCurrentAll = emptyOtif();
  const promiseHistory = emptyPromiseHistoryCoverage();
  const savingAll = emptySaving();

  // 统计年 01 月至当前月（历史年份至 12 月）的月桶固定存在，缺月显示 0 单（这是「没下单」而非「缺数据」，两者不同：PO 是系统事实）；
  // 不再带上年 10–12 月桶（inYear 只含本年 PO，那些桶恒为 0，只会误导读者）
  const lastMonthNo = Number(month.slice(5, 7));
  for (let m = 1; m <= lastMonthNo; m += 1) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    byMonth.set(key, { month: key, ...emptyVolume(), otif: emptyOtif(), otifCurrent: emptyOtif() });
  }

  for (const po of inYear) {
    const sup = bySupplier.get(po.supplierId) ?? {
      supplierId: po.supplierId,
      code: po.supplierCode,
      name: po.supplierName,
      ...emptyVolume(),
      cycle: cycleStats([], []),
      otif: emptyOtif(),
      otifCurrent: emptyOtif(),
      costSaving: emptySaving(),
      firstDays: [],
      fullDays: [],
    };
    bySupplier.set(po.supplierId, sup);
    const monthRow = byMonth.get(po.month)
      ?? { month: po.month, ...emptyVolume(), otif: emptyOtif(), otifCurrent: emptyOtif() };
    byMonth.set(po.month, monthRow);

    ytd.poCount += 1;
    sup.poCount += 1;
    monthRow.poCount += 1;
    if (po.month === month) thisMonth.poCount += 1;
    const brandPos = new Set<string>();

    let orderedBase = "0";
    let receivedBase = "0";
    for (const line of po.lines) {
      addVolume(ytd, line);
      addVolume(sup, line);
      addVolume(monthRow, line);
      if (po.month === month) addVolume(thisMonth, line);
      const bkey = String(line.brandId ?? "none");
      const brandRow = byBrand.get(bkey) ?? {
        brandId: line.brandId,
        brandCode: line.brandCode,
        brandName: line.brandName ?? "未归属品牌",
        ...emptyVolume(),
      };
      byBrand.set(bkey, brandRow);
      addVolume(brandRow, line);
      if (!brandPos.has(bkey)) {
        brandPos.add(bkey);
        brandRow.poCount += 1;
      }
      orderedBase = dAdd(orderedBase, line.baseQty, 4);
      receivedBase = dAdd(receivedBase, line.receivedQty, 4);
      countPromiseHistory(promiseHistory, line.promise);

      const cs = costSaving({ baselineUnitPrice: baseline.get(line.skuId) ?? null, currentUnitPrice: line.unitBaseNet, qty: line.baseQty });
      for (const acc of [savingAll, sup.costSaving]) {
        if (cs.comparable) {
          acc.comparableLines += 1;
          acc.savingYtd = dAdd(acc.savingYtd ?? "0", cs.saving, 2);
          acc.increaseYtd = dAdd(acc.increaseYtd ?? "0", cs.increase, 2);
        } else {
          acc.nonComparableLines += 1;
        }
      }
    }

    // 周期：「全收」与 OTIF 足量同口径（含 otif_qty_tolerance_pct 容差）
    const full = isFullReceipt(orderedBase, receivedBase, otifQtyTolerancePct);
    const cyc = orderToDeliveryDays({
      orderedAt: po.orderedAt,
      firstReceiptAt: po.firstReceiptAt,
      completedAt: full ? po.lastReceiptAt : null,
      promisedDate: null,
    });
    if (cyc.firstDays != null && cyc.firstDays >= 0) {
      firstDaysAll.push(cyc.firstDays);
      sup.firstDays.push(cyc.firstDays);
    }
    if (cyc.fullDays != null && cyc.fullDays >= 0) {
      fullDaysAll.push(cyc.fullDays);
      sup.fullDays.push(cyc.fullDays);
    }

    /* OTIF：主口径 = 原始承诺（反洗白），副口径 = 当前承诺（改期后的值），两个都算、都下发 */
    const lastReceiptDay = full ? shanghaiDay(po.lastReceiptAt) : null;
    const outcome = evaluateOtif({
      promised: promisedDate(po, OTIF_PRIMARY_BASIS),
      orderedBaseQty: orderedBase,
      receivedBaseQty: receivedBase,
      lastReceiptDay,
      today,
    }, otifParams);
    for (const o of [otifAll, sup.otif, monthRow.otif]) o[outcome] += 1;
    const currentOutcome = evaluateOtif({
      promised: promisedDate(po, OTIF_SECONDARY_BASIS),
      orderedBaseQty: orderedBase,
      receivedBaseQty: receivedBase,
      lastReceiptDay,
      today,
    }, otifParams);
    for (const o of [otifCurrentAll, sup.otifCurrent, monthRow.otifCurrent]) o[currentOutcome] += 1;
  }

  const supplierRows: PoSupplierRow[] = [...bySupplier.values()]
    .map(({ firstDays, fullDays, ...row }) => ({
      ...row,
      cycle: cycleStats(firstDays, fullDays),
      otif: finishOtif(row.otif),
      otifCurrent: finishOtif(row.otifCurrent),
    }))
    .sort((a, b) => dCmp(b.netAmount ?? "0", a.netAmount ?? "0") || a.code.localeCompare(b.code));

  return {
    key: PURCHASE_ORDER_METRICS_KEY,
    authority: "ledger",
    sourceBinding: await sourceBinding(db, year, otifParams),
    builtAt: new Date().toISOString(),
    asOf: today,
    year,
    month,
    baselineYear,
    moneyVisible: true,
    params: { otifWindowDays, otifQtyTolerancePct, minCycleSamples: MIN_CYCLE_SAMPLES },
    otifBasis: OTIF_PRIMARY_BASIS,
    otifBasisLabel: OTIF_PRIMARY_BASIS_LABEL,
    otifSecondaryBasis: OTIF_SECONDARY_BASIS,
    otifSecondaryBasisLabel: OTIF_SECONDARY_BASIS_LABEL,
    promiseHistory,
    summary: {
      thisMonth,
      ytd,
      cycle: cycleStats(firstDaysAll, fullDaysAll),
      otif: finishOtif(otifAll),
      otifCurrent: finishOtif(otifCurrentAll),
      costSaving: savingAll,
      invalidLines,
      orderedPoAllTime: pos.length,
    },
    byMonth: [...byMonth.values()]
      .map((m) => ({ ...m, otif: finishOtif(m.otif), otifCurrent: finishOtif(m.otifCurrent) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    bySupplier: supplierRows,
    byBrand: [...byBrand.values()].sort((a, b) => dCmp(b.orderedBaseQty, a.orderedBaseQty) || a.brandName.localeCompare(b.brandName)),
    limitations: [
      "已下单 = PO 审批通过时点（approvals），草稿/待审/驳回/作废不计；无审批记录的历史已批单不计入（不猜下单日）。",
      "金额为采购订单口径（未税为主、含税并列），不是应付或已付；采购退货（CT）只回冲数量（received_qty），不回冲已下单金额。",
      `订单至交付 = 审批 → 首批生效收货（SH 建单日）；全收 = 累计已收 ≥ 应收 × (1 − ${otifQtyTolerancePct}%) 时的最后一张 SH（与 OTIF 足量同口径）；样本 < 3 不出 P50/P90。`,
      `降本基线 = ${baselineYear} 年已批数量加权基础单位未税均价（按 SKU 跨供应商），无则取该 SKU 首个已批行价；只计降价，涨价另列不轧差。`,
      `OTIF：承诺日 + ${otifWindowDays} 天窗口内收齐（足量容差 ${otifQtyTolerancePct}%）记准时足量；缺承诺日进「不可评」；未到期未收齐为「待评」。`,
      `OTIF 主口径 = ${OTIF_PRIMARY_BASIS_LABEL}（po_promise_revisions 第一条可信修订），并列副口径 otifCurrent = ${OTIF_SECONDARY_BASIS_LABEL}；`
      + "供应商经确认门户改期只影响副口径，不再抬高主口径（v3 反洗白）。",
      `承诺版本链覆盖：可信 ${promiseHistory.trusted} 行 / 迁移快照 ${promiseHistory.backfilled} 行 / 无版本链 ${promiseHistory.missing} 行；`
      + "后两类的「原始承诺」是回落的当前承诺，不冒充真实原始承诺。",
      `按月：只列 ${year}-01 至 ${month} 的月桶，缺月为 0 单（当年确无已批 PO），不含上年月份。`,
      "逐月 OTIF 按下单月归期：近月的 PO 多半还没到承诺日，evaluable 结构性偏低，读数必须带 n（v2）。",
      "覆盖：仅 SCM 内 PO 事实，不含简道云旧采购单观察。",
    ],
  };
}

/* ───────────────────────── 缓存 ───────────────────────── */

function currentYear(): number {
  return Number(shanghaiDay(new Date())!.slice(0, 4));
}

export async function refreshPurchaseOrderMetrics(dbArg?: AnyDb): Promise<PurchaseOrderMetrics> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const model = await computePurchaseOrderMetrics(db);
  await db
    .insert(schema.reportReadModelCache)
    .values({ key: PURCHASE_ORDER_METRICS_KEY, sourceBinding: model.sourceBinding, payload: model, builtAt: new Date() })
    .onConflictDoUpdate({
      target: schema.reportReadModelCache.key,
      set: { sourceBinding: model.sourceBinding, payload: model, builtAt: new Date() },
    });
  return model;
}

/**
 * 页面读：当年走缓存（绑定一致才用），历史年份即时计算不缓存。
 */
/**
 * 有「已下单」事实的年份（审批通过时点按 Asia/Shanghai 取年），降序；恒含当年。
 * 供报表页年份下拉（审计：年份列表曾来自浏览器时钟，与读模型 baselineYear 不一致、有数据的年份够不着）。
 */
export async function listPurchaseOrderYears(dbArg?: AnyDb): Promise<number[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const ordered: { docId: number; orderedAt: Date | string }[] = await db
    .select({ docId: schema.approvals.docId, orderedAt: sql<Date | string>`max(${schema.approvals.createdAt})` })
    .from(schema.approvals)
    .innerJoin(schema.poDocs, eq(schema.approvals.docId, schema.poDocs.id))
    .where(and(eq(schema.approvals.docType, "po"), eq(schema.approvals.action, "approve"), inArray(schema.poDocs.status, [...ORDERED_PO_STATUSES])))
    .groupBy(schema.approvals.docId);
  const years = new Set<number>([currentYear()]);
  for (const r of ordered) {
    const day = shanghaiDay(r.orderedAt);
    if (day) years.add(Number(day.slice(0, 4)));
  }
  return [...years].filter((y) => Number.isInteger(y) && y > 2000).sort((a, b) => b - a);
}

export async function loadPurchaseOrderMetrics(opts: { year?: number } = {}, dbArg?: AnyDb): Promise<PurchaseOrderMetrics> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const year = opts.year ?? currentYear();
  if (year !== currentYear()) return computePurchaseOrderMetrics(db, { year });
  const binding = await sourceBinding(db, year, await readOtifParams(db));
  const [row] = await db
    .select({ payload: schema.reportReadModelCache.payload, sourceBinding: schema.reportReadModelCache.sourceBinding })
    .from(schema.reportReadModelCache)
    .where(eq(schema.reportReadModelCache.key, PURCHASE_ORDER_METRICS_KEY));
  if (row && row.sourceBinding === binding) {
    const payload = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Partial<PurchaseOrderMetrics>;
    if (payload?.key === PURCHASE_ORDER_METRICS_KEY && payload.summary && payload.bySupplier) {
      return payload as PurchaseOrderMetrics;
    }
  }
  return refreshPurchaseOrderMetrics(db);
}

/* ───────────────────────── 出口脱敏 ───────────────────────── */

function stripVolume<T extends PoVolume>(v: T): T {
  return { ...v, netAmount: null, grossAmount: null };
}

/** 金额出口：非价格角色剥掉全部金额键（单数/数量保留）。路由必须调用。 */
export function stripPurchaseOrderMoney(model: PurchaseOrderMetrics, roles: string[]): PurchaseOrderMetrics {
  if (canSeePrices(roles)) return { ...model, moneyVisible: true };
  const stripSaving = (s: CostSavingStats): CostSavingStats => ({ ...s, savingYtd: null, increaseYtd: null });
  return {
    ...model,
    moneyVisible: false,
    summary: {
      ...model.summary,
      thisMonth: stripVolume(model.summary.thisMonth),
      ytd: stripVolume(model.summary.ytd),
      costSaving: stripSaving(model.summary.costSaving),
    },
    byMonth: model.byMonth.map(stripVolume),
    bySupplier: model.bySupplier.map((r) => ({ ...stripVolume(r), costSaving: stripSaving(r.costSaving) })),
    byBrand: model.byBrand.map(stripVolume),
  };
}

/** 驾驶舱第 2 屏「订单系统 / 成本下降」卡数据块（只消费读模型，不再算） */
export interface PurchaseOrderCockpitBlock {
  asOf: string;
  month: string;
  moneyVisible: boolean;
  orderSystem: {
    monthPoCount: number;
    monthOrderedBaseQty: string;
    monthNetAmount: string | null;
    monthGrossAmount: string | null;
    cycleFirstP50: number | null;
    cycleFirstP90: number | null;
    cycleSamples: number;
    cycleInsufficient: boolean;
    /** 主口径（原始承诺）准时率 */
    otifRate: number | null;
    otifEvaluable: number;
    /** 副口径（当前承诺）准时率——与主口径并列，供驾驶舱标注改期影响 */
    otifCurrentRate: number | null;
    otifCurrentEvaluable: number;
    otifBasisLabel: string;
    otifSecondaryBasisLabel: string;
  };
  costDown: {
    savingYtd: string | null;
    increaseYtd: string | null;
    comparableLines: number;
    nonComparableLines: number;
    baselineYear: number;
  };
}

export function purchaseOrderCockpitBlock(model: PurchaseOrderMetrics): PurchaseOrderCockpitBlock {
  const s = model.summary;
  return {
    asOf: model.asOf,
    month: model.month,
    moneyVisible: model.moneyVisible,
    orderSystem: {
      monthPoCount: s.thisMonth.poCount,
      monthOrderedBaseQty: s.thisMonth.orderedBaseQty,
      monthNetAmount: s.thisMonth.netAmount,
      monthGrossAmount: s.thisMonth.grossAmount,
      cycleFirstP50: s.cycle.firstP50,
      cycleFirstP90: s.cycle.firstP90,
      cycleSamples: s.cycle.n,
      cycleInsufficient: s.cycle.insufficient,
      otifRate: s.otif.rate,
      otifEvaluable: s.otif.evaluable,
      otifCurrentRate: s.otifCurrent.rate,
      otifCurrentEvaluable: s.otifCurrent.evaluable,
      otifBasisLabel: model.otifBasisLabel,
      otifSecondaryBasisLabel: model.otifSecondaryBasisLabel,
    },
    costDown: {
      savingYtd: s.costSaving.savingYtd,
      increaseYtd: s.costSaving.increaseYtd,
      comparableLines: s.costSaving.comparableLines,
      nonComparableLines: s.costSaving.nonComparableLines,
      baselineYear: model.baselineYear,
    },
  };
}
