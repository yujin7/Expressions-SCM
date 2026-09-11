import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { dAdd } from "@/server/core/decimal";
import {
  compareCapacity,
  supplierCapacityStats,
  type CapacityMonth,
  type CapacityStats,
} from "@/server/rules/supplier-capacity";
import { type AnyDb, resolveDb } from "@/server/modules/outsource/common";
import { shanghaiMonthOf, shanghaiDayOf, shanghaiDay } from "@/server/core/business-day";
import { compareDeclaredCapacity, type DeclaredCapacityComparison } from "@/server/rules/declared-capacity";

const EFFECTIVE_SH_STATUSES = ["approved", "in_progress", "completed"] as const;
const OPEN_JG_STATUSES = ["draft", "pending", "approved", "in_progress"] as const;
const HISTORY_MONTHS = 12;

function shanghaiParts(date: Date): { year: number; month: number } {
  const [y, m] = shanghaiMonthOf(date).split("-");
  return { year: Number(y), month: Number(m) };
}

function monthKey(date: Date): string {
  const { year, month } = shanghaiParts(date);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthKeyFromDate(value: string | null, fallback: Date): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(0, 7);
  return monthKey(fallback);
}

function shanghaiMonthStartUtc(year: number, month: number): Date {
  // Shanghai has used UTC+8 throughout the product's relevant history.
  return new Date(Date.UTC(year, month - 1, 1) - 8 * 60 * 60 * 1000);
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export interface SupplierCapacitySignal {
  basis: "effective_jg_receipts_active_month_p90";
  advisoryOnly: true;
  supplierId: number;
  baseUom: string;
  dueMonth: string;
  historyWindow: { from: string; to: string; completeMonths: number };
  stats: CapacityStats;
  scheduledQty: string;
  candidateQty: string;
  projectedQty: string;
  utilizationPct: string | null;
  overP90: boolean;
  excessQty: string;
  explanation: string;
  limitations: string[];
  declared: DeclaredCapacityComparison;
  undatedOrders: number;
}

export async function getSupplierCapacitySignal(
  input: {
    supplierId: number;
    baseUom: string;
    dueDate: string | null;
    candidateQty?: string;
    excludeJgId?: number;
    asOf?: Date;
  },
  dbArg?: AnyDb,
): Promise<SupplierCapacitySignal> {
  const db = await resolveDb(dbArg);
  const asOf = input.asOf ?? new Date();
  const current = shanghaiParts(asOf);
  const historyStart = addMonths(current.year, current.month, -HISTORY_MONTHS);
  const from = shanghaiMonthStartUtc(historyStart.year, historyStart.month);
  const to = shanghaiMonthStartUtc(current.year, current.month);

  const receiptRows: { createdAt: Date; actualQty: string }[] = await db
    .select({ createdAt: schema.shDocs.createdAt, actualQty: schema.shLines.actualQty })
    .from(schema.shLines)
    .innerJoin(schema.shDocs, eq(schema.shLines.shId, schema.shDocs.id))
    .innerJoin(schema.jgDocs, eq(schema.shDocs.sourceId, schema.jgDocs.id))
    .innerJoin(schema.skus, eq(schema.shLines.skuId, schema.skus.id))
    .where(and(
      eq(schema.shDocs.sourceType, "jg"),
      inArray(schema.shDocs.status, [...EFFECTIVE_SH_STATUSES]),
      eq(schema.jgDocs.supplierId, input.supplierId),
      eq(schema.skus.baseUom, input.baseUom),
      gte(schema.shDocs.createdAt, from),
      lt(schema.shDocs.createdAt, to),
    ));

  const byMonth = new Map<string, string>();
  for (const row of receiptRows) {
    const key = monthKey(row.createdAt);
    byMonth.set(key, dAdd(byMonth.get(key) ?? "0", row.actualQty));
  }
  const months: CapacityMonth[] = [...byMonth.entries()].map(([month, actualQty]) => ({ month, actualQty }));
  const stats = supplierCapacityStats(months);

  const [declaration] = await db.select({
    declaredMonthlyCapacity: schema.suppliers.declaredMonthlyCapacity,
    capacityUom: schema.suppliers.capacityUom, surgeCapacityPct: schema.suppliers.surgeCapacityPct,
    capacityValidFrom: schema.suppliers.capacityValidFrom, capacityValidUntil: schema.suppliers.capacityValidUntil,
    capacityEvidence: schema.suppliers.capacityEvidence,
  }).from(schema.suppliers).where(eq(schema.suppliers.id, input.supplierId));

  const dueMonth = monthKeyFromDate(input.dueDate, asOf);
  const scheduledConds = [
    eq(schema.jgDocs.supplierId, input.supplierId),
    eq(schema.skus.baseUom, input.baseUom),
    inArray(schema.jgDocs.status, [...OPEN_JG_STATUSES]),
  ];
  if (input.excludeJgId != null) scheduledConds.push(ne(schema.jgDocs.id, input.excludeJgId));
  const scheduledRows: { qty: string; dueDate: string | null; createdAt: Date }[] = await db
    .select({ qty: schema.jgDocs.qty, dueDate: schema.jgDocs.dueDate, createdAt: schema.jgDocs.createdAt })
    .from(schema.jgDocs)
    .innerJoin(schema.skus, eq(schema.jgDocs.productSkuId, schema.skus.id))
    .where(and(...scheduledConds));
  let scheduledQty = "0.0000";
  for (const row of scheduledRows) {
    if (monthKeyFromDate(row.dueDate, row.createdAt) === dueMonth) {
      scheduledQty = dAdd(scheduledQty, row.qty);
    }
  }

  const comparison = compareCapacity(scheduledQty, input.candidateQty ?? "0", stats.p90);
  const undatedOrders = scheduledRows.filter(row => !row.dueDate || shanghaiDay(row.dueDate) == null).length;
  const declared = compareDeclaredCapacity(declaration ?? {
    declaredMonthlyCapacity: null, capacityUom: null, surgeCapacityPct: null,
    capacityValidFrom: null, capacityValidUntil: null, capacityEvidence: null,
  }, { baseUom: input.baseUom, dueDate: input.dueDate, asOfDay: shanghaiDayOf(asOf), projectedQty: comparison.projectedQty, undatedOrders });
  const historyTo = addMonths(current.year, current.month, -1);
  return {
    basis: "effective_jg_receipts_active_month_p90",
    advisoryOnly: true,
    supplierId: input.supplierId,
    baseUom: input.baseUom,
    dueMonth,
    historyWindow: {
      from: `${historyStart.year}-${String(historyStart.month).padStart(2, "0")}`,
      to: `${historyTo.year}-${String(historyTo.month).padStart(2, "0")}`,
      completeMonths: HISTORY_MONTHS,
    },
    stats,
    ...comparison,
    declared,
    undatedOrders,
    explanation: stats.reliable
      ? `按最近 ${HISTORY_MONTHS} 个完整月的有效 JG 收货，${input.baseUom} 活跃月产出 P90 为 ${stats.p90}；${dueMonth} 计划负荷为 ${comparison.projectedQty}。`
      : `有效活跃月样本不足（${stats.sampleMonths}/${stats.minMonths}），暂不形成产能阈值。`,
    limitations: [
      "这是历史活跃月吞吐量信号，不是供应商承诺或合同产能。",
      "不同基础单位严格分开计算；未建立可靠换算前不跨单位汇总。",
      "当前未完成月份不进入历史 P90，零产出月不代表零产能。",
      "软约束只提示、不阻断建单或审批。",
      "计划负荷采用本系统未结JG全单量（含草稿），不是剩余加工量；不含供应商其他客户占用。",
      "申报情景与历史P90分开，不相加；未填交期的历史负荷按建单月归集，不代表实际排程。",
    ],
  };
}

export function capacityAuditSnapshot(signal: SupplierCapacitySignal) {
  return {
    basis: signal.basis,
    advisoryOnly: true,
    baseUom: signal.baseUom,
    dueMonth: signal.dueMonth,
    sampleMonths: signal.stats.sampleMonths,
    minMonths: signal.stats.minMonths,
    p90: signal.stats.p90,
    scheduledQty: signal.scheduledQty,
    candidateQty: signal.candidateQty,
    projectedQty: signal.projectedQty,
    utilizationPct: signal.utilizationPct,
    overP90: signal.overP90,
    excessQty: signal.excessQty,
    declared: signal.declared,
    undatedOrders: signal.undatedOrders,
  };
}
