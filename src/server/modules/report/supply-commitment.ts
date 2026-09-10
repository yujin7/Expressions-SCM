/**
 * 供给承诺可信度：先建立 SCM 内部可重放基线，再等待简道云/JST/用友各自成为独立对照边。
 *
 * 纪律：
 * - 分母只含已经到期、具有有效承诺日且收货来源无歧义的采购行；
 * - 数量统一换算为基础单位，收货只计已质检合格/接收量，采购退货按事件日期回冲；
 * - SH显式采购行优先，历史只兼容唯一PO×SKU；归属不清的行必须排除并披露；
 * - 收货/退货事件净额与 po_lines.received_qty 不一致时停止该行计算，不用其中一边覆盖另一边；
 * - 原始承诺只接受可信版本链；当前承诺单列，不用改期覆盖迟延；
 * - 外部三边未通过身份、单位、状态和 UAT 前，不参与本计算，也不改变 SCM 正式事实。
 */
import { and, eq, inArray } from "drizzle-orm";

import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { dayDiff as daysBetween, shanghaiDayOf} from "@/server/core/business-day";
import { dAdd, dCmp, dMul, dQty, dSub } from "@/server/core/decimal";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { resolvePromiseBasis, type PromiseHistoryState } from "@/server/rules/promise-basis";
import { indexPurchaseLineReceipts } from "./purchase-line-receipts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const EFFECTIVE_PO_STATUSES = ["approved", "in_progress", "completed"] as const;
const EFFECTIVE_SH_STATUSES = ["approved", "in_progress", "completed"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 180;
const DEFAULT_LIMIT = 30;

export type PromiseReliabilityStatus = "on_time_in_full" | "late_full" | "overdue_short";

export interface PromiseLineFact {
  lineId: number;
  poId: number;
  docNo: string;
  supplierCode: string;
  supplierName: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  orderQty: string;
  uomFactor: string;
  currentReceivedQty: string;
  promisedDate: string | null;
  originalPromisedDate: string | null;
  promiseHistoryState: PromiseHistoryState;
  revisionCount: number;
}

export interface PromiseReceiptFact {
  poId: number;
  poLineId?: number | null;
  skuId: number;
  acceptedQty: string;
  acceptedDate: string;
}

export interface PromiseReturnFact {
  poLineId: number;
  qty: string;
  returnedDate: string;
}

export interface PromiseReliabilityRow {
  lineId: number;
  poId: number;
  docNo: string;
  supplierCode: string;
  supplierName: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  basis: "original" | "current";
  promisedDate: string;
  originalPromisedDate: string | null;
  currentPromisedDate: string | null;
  promiseHistoryState: PromiseLineFact["promiseHistoryState"];
  revisionCount: number;
  status: PromiseReliabilityStatus;
  orderedQty: number;
  receivedByPromise: number;
  receivedAsOf: number;
  shortQty: number;
  daysLate: number;
  fulfilledDate: string | null;
}

export interface PromiseReliability {
  state: "ready" | "insufficient";
  authority: "scm_internal_baseline";
  asOf: string;
  windowDays: number;
  windowFrom: string;
  grain: "采购行（收货来源可核对）";
  promiseVersionState: "immutable_history" | "mixed_history" | "current_only";
  rate: number | null;
  originalRate: number | null;
  totals: {
    effectiveLines: number;
    promisedLines: number;
    eligibleLines: number;
    onTimeInFull: number;
    lateFull: number;
    overdueShort: number;
    undated: number;
    future: number;
    outsideWindow: number;
    ambiguous: number;
    controlMismatch: number;
  };
  originalTotals: {
    eligibleLines: number;
    onTimeInFull: number;
    lateFull: number;
    overdueShort: number;
    historyTrusted: number;
    historyBackfilled: number;
    historyMissing: number;
    future: number;
    outsideWindow: number;
    ambiguous: number;
    controlMismatch: number;
  };
  coverage: {
    promisePct: number | null;
    calculablePct: number | null;
    historyPct: number | null;
  };
  exceptions: PromiseReliabilityRow[];
  gate: string | null;
  historyGate: string | null;
  limitations: string[];
  externalEdges: Array<{
    source: "JIANDAOYUN" | "JST" | "YONYOU";
    state: "awaiting_uat";
    purpose: string;
  }>;
}

const q = (value: string): number => Number(dQty(value));
const pct = (part: number, total: number): number | null =>
  total > 0 ? Math.round((part / total) * 10_000) / 100 : null;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function cumulativeNet(
  receipts: PromiseReceiptFact[],
  returns: PromiseReturnFact[],
  through: string,
): string {
  let total = "0";
  for (const item of receipts) {
    if (item.acceptedDate <= through) total = dAdd(total, item.acceptedQty);
  }
  for (const item of returns) {
    if (item.returnedDate <= through) total = dSub(total, item.qty);
  }
  return dCmp(total, "0") < 0 ? "0" : dQty(total);
}

function firstFulfilledDate(
  receipts: PromiseReceiptFact[],
  returns: PromiseReturnFact[],
  requiredQty: string,
  asOf: string,
): string | null {
  const dates = [...new Set([
    ...receipts.filter((item) => item.acceptedDate <= asOf).map((item) => item.acceptedDate),
    ...returns.filter((item) => item.returnedDate <= asOf).map((item) => item.returnedDate),
  ])].sort();
  for (const date of dates) {
    if (dCmp(cumulativeNet(receipts, returns, date), requiredQty) >= 0) return date;
  }
  return null;
}

/** 纯函数计算器；加载器只负责把受控事实变成这三个输入集合。 */
export function buildPromiseReliability(
  lines: PromiseLineFact[],
  receipts: PromiseReceiptFact[],
  returns: PromiseReturnFact[],
  options: { asOf: string; windowDays?: number; limit?: number },
): PromiseReliability {
  const asOf = options.asOf;
  if (!DATE_RE.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
    throw new ApiError(400, "供给承诺截止日格式不正确（应为 YYYY-MM-DD）");
  }
  const windowDays = Math.min(1095, Math.max(30, options.windowDays ?? DEFAULT_WINDOW_DAYS));
  const limit = Math.min(200, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const windowFrom = addDays(asOf, -(windowDays - 1));
  const receiptIndex = indexPurchaseLineReceipts(
    lines.map(line => ({ id: line.lineId, poId: line.poId, skuId: line.skuId })), receipts,
  );
  const returnsByLine = new Map<number, PromiseReturnFact[]>();
  for (const item of returns) {
    const list = returnsByLine.get(item.poLineId) ?? [];
    list.push(item);
    returnsByLine.set(item.poLineId, list);
  }

  const totals = {
    effectiveLines: lines.length,
    promisedLines: 0,
    eligibleLines: 0,
    onTimeInFull: 0,
    lateFull: 0,
    overdueShort: 0,
    undated: 0,
    future: 0,
    outsideWindow: 0,
    ambiguous: 0,
    controlMismatch: 0,
  };
  const originalTotals = {
    eligibleLines: 0,
    onTimeInFull: 0,
    lateFull: 0,
    overdueShort: 0,
    historyTrusted: 0,
    historyBackfilled: 0,
    historyMissing: 0,
    future: 0,
    outsideWindow: 0,
    ambiguous: 0,
    controlMismatch: 0,
  };
  const rows: PromiseReliabilityRow[] = [];

  for (const line of lines) {
    if (line.promiseHistoryState === "trusted" && line.originalPromisedDate) {
      originalTotals.historyTrusted += 1;
    } else if (line.promiseHistoryState === "backfilled") {
      originalTotals.historyBackfilled += 1;
    } else if (line.promisedDate) {
      originalTotals.historyMissing += 1;
    }

    let currentEligible = false;
    if (!line.promisedDate) {
      totals.undated += 1;
    } else {
      totals.promisedLines += 1;
      if (line.promisedDate > asOf) totals.future += 1;
      else if (line.promisedDate < windowFrom) totals.outsideWindow += 1;
      else currentEligible = true;
    }

    let originalEligible = false;
    if (line.promiseHistoryState === "trusted" && line.originalPromisedDate) {
      if (line.originalPromisedDate > asOf) originalTotals.future += 1;
      else if (line.originalPromisedDate < windowFrom) originalTotals.outsideWindow += 1;
      else originalEligible = true;
    }
    if (!currentEligible && !originalEligible) continue;

    if (receiptIndex.unresolvedLineIds.has(line.lineId)) {
      if (currentEligible) totals.ambiguous += 1;
      if (originalEligible) originalTotals.ambiguous += 1;
      continue;
    }
    const lineReceipts = receiptIndex.byLine.get(line.lineId) ?? [];
    const lineReturns = returnsByLine.get(line.lineId) ?? [];
    const receivedAsOf = cumulativeNet(lineReceipts, lineReturns, asOf);
    if (dCmp(receivedAsOf, line.currentReceivedQty) !== 0) {
      if (currentEligible) totals.controlMismatch += 1;
      if (originalEligible) originalTotals.controlMismatch += 1;
      continue;
    }

    const orderedQty = dMul(line.orderQty, line.uomFactor, 6);
    const fulfilledDate = firstFulfilledDate(lineReceipts, lineReturns, orderedQty, asOf);
    const short = dSub(orderedQty, receivedAsOf);
    const addBasis = (
      basis: "original" | "current",
      promisedDate: string,
      basisTotals: Pick<typeof totals, "eligibleLines" | "onTimeInFull" | "lateFull" | "overdueShort">,
    ) => {
      const receivedByPromise = cumulativeNet(lineReceipts, lineReturns, promisedDate);
      let status: PromiseReliabilityStatus;
      if (dCmp(receivedByPromise, orderedQty) >= 0) {
        status = "on_time_in_full";
        basisTotals.onTimeInFull += 1;
      } else if (dCmp(receivedAsOf, orderedQty) >= 0) {
        status = "late_full";
        basisTotals.lateFull += 1;
      } else {
        status = "overdue_short";
        basisTotals.overdueShort += 1;
      }
      basisTotals.eligibleLines += 1;
      rows.push({
        lineId: line.lineId,
        poId: line.poId,
        docNo: line.docNo,
        supplierCode: line.supplierCode,
        supplierName: line.supplierName,
        skuId: line.skuId,
        skuCode: line.skuCode,
        skuName: line.skuName,
        baseUom: line.baseUom,
        basis,
        promisedDate,
        originalPromisedDate: line.originalPromisedDate,
        currentPromisedDate: line.promisedDate,
        promiseHistoryState: line.promiseHistoryState,
        revisionCount: line.revisionCount,
        status,
        orderedQty: q(orderedQty),
        receivedByPromise: q(receivedByPromise),
        receivedAsOf: q(receivedAsOf),
        shortQty: dCmp(short, "0") > 0 ? q(short) : 0,
        daysLate: status === "on_time_in_full" ? 0 : daysBetween(promisedDate, fulfilledDate ?? asOf),
        fulfilledDate,
      });
    };
    if (originalEligible) addBasis("original", line.originalPromisedDate!, originalTotals);
    if (currentEligible) addBasis("current", line.promisedDate!, totals);
  }

  const exceptions = rows
    .filter((row) => row.status !== "on_time_in_full")
    .sort((a, b) => {
      const statusOrder: Record<PromiseReliabilityStatus, number> = {
        overdue_short: 0,
        late_full: 1,
        on_time_in_full: 2,
      };
      return statusOrder[a.status] - statusOrder[b.status]
        || (a.basis === b.basis ? 0 : a.basis === "original" ? -1 : 1)
        || b.daysLate - a.daysLate
        || b.shortQty - a.shortQty
        || a.docNo.localeCompare(b.docNo);
    })
    .slice(0, limit);
  const calculableBase = totals.eligibleLines + totals.ambiguous + totals.controlMismatch;
  const historyBase = originalTotals.historyTrusted + originalTotals.historyBackfilled + originalTotals.historyMissing;
  const state = totals.eligibleLines > 0 || originalTotals.eligibleLines > 0 ? "ready" : "insufficient";
  const promiseVersionState = originalTotals.historyTrusted === 0
    ? "current_only"
    : originalTotals.historyBackfilled > 0 || originalTotals.historyMissing > 0
      ? "mixed_history"
      : "immutable_history";
  return {
    state,
    authority: "scm_internal_baseline",
    asOf,
    windowDays,
    windowFrom,
    grain: "采购行（收货来源可核对）",
    promiseVersionState,
    rate: pct(totals.onTimeInFull, totals.eligibleLines),
    originalRate: pct(originalTotals.onTimeInFull, originalTotals.eligibleLines),
    totals,
    originalTotals,
    coverage: {
      promisePct: pct(totals.promisedLines, totals.effectiveLines),
      calculablePct: pct(totals.eligibleLines, calculableBase),
      historyPct: pct(originalTotals.historyTrusted, historyBase),
    },
    exceptions,
    gate: state === "ready"
      ? null
      : "窗口内没有可安全计算的已到期采购承诺行；无交期、未来交期、收货归属不清、版本缺口和控制量不一致均不会被当作零。",
    historyGate: originalTotals.eligibleLines > 0
      ? null
      : "窗口内尚无可安全使用的原始承诺版本分母；迁移快照与缺失历史不会冒充原始承诺。",
    limitations: [
      "当前只计算 SCM 内部采购承诺基线；简道云流程、聚水潭入库和用友 PO/入库尚未通过身份、单位、状态与 UAT，不参与本率值。",
      "新发生的供应商承诺与改期已进入不可变版本链；迁移前日期仅标为当前快照，不倒推、不冒充原始承诺。原始承诺与当前承诺分列，避免改期覆盖掩盖迟延。",
      "收货按明确采购行核对；历史未记行号时仅兼容同PO唯一SKU。归属不清或与PO/SKU冲突的相关行排除并计入覆盖缺口，不自动分摊。无收货事件且已收控制量确为0的到期行仍计逾期未齐。",
      "跨 SKU 数量不汇总；率值以采购承诺行计数，质量、价格与财务责任需在各自证据链独立判断。",
    ],
    externalEdges: [
      { source: "JIANDAOYUN", state: "awaiting_uat", purpose: "历史采购流程与人工承诺佐证" },
      { source: "JST", state: "awaiting_uat", purpose: "仓配实际入库佐证" },
      { source: "YONYOU", state: "awaiting_uat", purpose: "ERP 采购订单与入库财务佐证" },
    ],
  };
}

const shanghaiDate = shanghaiDayOf;

export async function loadPromiseReliability(
  query: { asOf?: string; windowDays?: number; limit?: number } = {},
  dbArg?: AnyDb,
): Promise<PromiseReliability> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  type LoadedLine = Omit<
    PromiseLineFact,
    "promisedDate" | "originalPromisedDate" | "promiseHistoryState" | "revisionCount"
  > & { promisedDate: string | null; docPromisedDate: string | null };
  const rawLines: LoadedLine[] = await db
    .select({
      lineId: schema.poLines.id,
      poId: schema.poDocs.id,
      docNo: schema.poDocs.docNo,
      supplierCode: schema.suppliers.code,
      supplierName: schema.suppliers.name,
      skuId: schema.poLines.skuId,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      baseUom: schema.skus.baseUom,
      orderQty: schema.poLines.qty,
      uomFactor: schema.poLines.uomFactor,
      currentReceivedQty: schema.poLines.receivedQty,
      promisedDate: schema.poLines.expectedDate,
      docPromisedDate: schema.poDocs.expectedDate,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .innerJoin(schema.suppliers, eq(schema.poDocs.supplierId, schema.suppliers.id))
    .innerJoin(schema.skus, eq(schema.poLines.skuId, schema.skus.id))
    .where(inArray(schema.poDocs.status, [...EFFECTIVE_PO_STATUSES]));
  const revisionRows: Array<{
    poLineId: number;
    sequence: number;
    promisedDate: string | null;
    source: string;
  }> = rawLines.length > 0
    ? await db
      .select({
        poLineId: schema.poPromiseRevisions.poLineId,
        sequence: schema.poPromiseRevisions.sequence,
        promisedDate: schema.poPromiseRevisions.promisedDate,
        source: schema.poPromiseRevisions.source,
      })
      .from(schema.poPromiseRevisions)
      .where(inArray(schema.poPromiseRevisions.poLineId, rawLines.map((line) => line.lineId)))
      .orderBy(schema.poPromiseRevisions.poLineId, schema.poPromiseRevisions.sequence)
    : [];
  const revisionsByLine = new Map<number, typeof revisionRows>();
  for (const revision of revisionRows) {
    const list = revisionsByLine.get(revision.poLineId) ?? [];
    list.push(revision);
    revisionsByLine.set(revision.poLineId, list);
  }
  const lines: PromiseLineFact[] = rawLines.map(({ docPromisedDate, ...line }) => {
    // 原始承诺口径唯一权威 = rules/promise-basis.ts（记分卡与 PO 指标读同一份实现，
    // 否则「原始承诺」会在三处各写一遍、各漂一次）
    const fact = resolvePromiseBasis(revisionsByLine.get(line.lineId) ?? []);
    return {
      ...line,
      promisedDate: line.promisedDate ?? docPromisedDate ?? null,
      originalPromisedDate: fact.originalPromisedDate,
      promiseHistoryState: fact.historyState,
      revisionCount: fact.revisionCount,
    };
  });

  const receiptRows: Array<{
    poId: number;
    poLineId: number | null;
    skuId: number;
    passQty: string;
    concessionQty: string;
    acceptedAt: Date;
  }> = await db
    .select({
      poId: schema.shDocs.sourceId,
      poLineId: schema.shLines.poLineId,
      skuId: schema.shLines.skuId,
      passQty: schema.qcLines.passQty,
      concessionQty: schema.qcLines.concessionQty,
      acceptedAt: schema.qcRecords.createdAt,
    })
    .from(schema.shDocs)
    .innerJoin(schema.shLines, eq(schema.shLines.shId, schema.shDocs.id))
    .innerJoin(schema.qcRecords, eq(schema.qcRecords.shId, schema.shDocs.id))
    .innerJoin(schema.qcLines, eq(schema.qcLines.shLineId, schema.shLines.id))
    .where(and(eq(schema.shDocs.sourceType, "po"), inArray(schema.shDocs.status, [...EFFECTIVE_SH_STATUSES])));
  const returnRows: Array<{ poLineId: number; qty: string; returnedAt: Date }> = await db
    .select({
      poLineId: schema.ctLines.poLineId,
      qty: schema.ctLines.qty,
      returnedAt: schema.ctDocs.createdAt,
    })
    .from(schema.ctDocs)
    .innerJoin(schema.ctLines, eq(schema.ctLines.ctId, schema.ctDocs.id))
    .where(eq(schema.ctDocs.status, "completed"));

  return buildPromiseReliability(
    lines,
    receiptRows.map((row) => ({
      poId: row.poId,
      poLineId: row.poLineId,
      skuId: row.skuId,
      // SH 过账与 po_lines.received_qty 均以“合格 + 让步接收”为有效接收量。
      acceptedQty: dAdd(row.passQty, row.concessionQty),
      acceptedDate: shanghaiDate(new Date(row.acceptedAt)),
    })),
    returnRows.map((row) => ({
      poLineId: row.poLineId,
      qty: row.qty,
      returnedDate: shanghaiDate(new Date(row.returnedAt)),
    })),
    { asOf: query.asOf ?? todayShanghai(), windowDays: query.windowDays, limit: query.limit },
  );
}
