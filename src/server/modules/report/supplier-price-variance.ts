/**
 * 供应商价格偏差（采购观察值）。
 *
 * 目的：把已生效 PO 行的采购单位价统一成「基础单位未税价」，再按
 * (SKU × 供应商) 做数量加权均价，并与同一 SKU 窗口内的最低可比均价比较。
 *
 * 重要门禁：
 * - PO 行当前没有显式币种字段，只能沿用系统采购基准币种 CNY 的约定；
 * - 用友供应商权威身份尚未通过真实账号 UAT；
 * 因此本读模型只能用于发现值得复核的采购价格信号，不能作为财务定价、供应商
 * 自动排名或自动停用依据。页面和 API 必须把该限制连同结果一起返回。
 */
import { and, eq, gte, inArray } from "drizzle-orm";

import * as schema from "@/db/schema";
import { dAdd, dCmp, dDeviationPct, dDiv, dMoney, dMul, dQty } from "@/server/core/decimal";
import { type AnyDb, resolveDb } from "@/server/modules/outsource/common";
import { normalizeToBaseNet, PriceRuleError } from "@/server/rules/price";
import { shanghaiDayOf } from "@/server/core/business-day";

const EFFECTIVE_PO_STATUSES = ["approved", "in_progress", "completed"] as const;
export const DEFAULT_PRICE_VARIANCE_WINDOW_DAYS = 180;

export interface PurchasePriceObservation {
  lineId: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  qty: string;
  uomFactor: string;
  price: string;
  taxIncluded: boolean;
  taxRatePct: string;
}

export interface SupplierPriceVarianceRow {
  key: string;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  /** 当前数据模型的系统采购基准币种；不是 PO 行级外部凭证币种。 */
  currency: "CNY";
  lineCount: number;
  orderedBaseQty: string;
  averageBaseNetPrice: string;
  benchmarkBaseNetPrice: string;
  variancePct: string;
  isBenchmark: boolean;
}

export interface SupplierPriceVarianceSummaryRow {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  comparableSkuCount: number;
  aboveBenchmarkSkuCount: number;
  medianVariancePct: string;
}

export interface SupplierPriceVarianceResult {
  rows: SupplierPriceVarianceRow[];
  total: number;
  supplierSummary: SupplierPriceVarianceSummaryRow[];
  summary: {
    inputLineCount: number;
    validLineCount: number;
    comparableLineCount: number;
    excludedInvalidLineCount: number;
    singleSupplierLineCount: number;
    comparableSkuCount: number;
    comparableSupplierCount: number;
    coveragePct: string;
    windowDays: number;
    asOf: string;
  };
  readiness: {
    level: "observation";
    decisionReady: false;
    currencyState: "system_default_not_line_level";
    yonyouSupplierIdentityState: "uat_required";
    blockers: string[];
    permittedUse: string;
    prohibitedUse: string;
  };
}

interface SupplierSkuAggregate {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  lineCount: number;
  orderedBaseQty: string;
  orderedNetValue: string;
  averageBaseNetPrice: string;
}

function median(values: string[]): string {
  if (values.length === 0) return "0.00";
  const ordered = [...values].sort(dCmp);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return dDiv(dAdd(ordered[middle - 1], ordered[middle], 6), "2", 2);
}

function summarizeSupplierRows(rows: SupplierPriceVarianceRow[]): SupplierPriceVarianceSummaryRow[] {
  const supplierMap = new Map<number, { supplierCode: string; supplierName: string; values: string[]; above: number }>();
  for (const row of rows) {
    const value = supplierMap.get(row.supplierId) ?? {
      supplierCode: row.supplierCode,
      supplierName: row.supplierName,
      values: [],
      above: 0,
    };
    value.values.push(row.variancePct);
    if (!row.isBenchmark) value.above += 1;
    supplierMap.set(row.supplierId, value);
  }
  return [...supplierMap.entries()]
    .map(([supplierId, value]) => ({
      supplierId,
      supplierCode: value.supplierCode,
      supplierName: value.supplierName,
      comparableSkuCount: value.values.length,
      aboveBenchmarkSkuCount: value.above,
      medianVariancePct: median(value.values),
    }))
    .sort((a, b) => dCmp(b.medianVariancePct, a.medianVariancePct) || a.supplierCode.localeCompare(b.supplierCode));
}

/**
 * 纯计算器：不跨 SKU 汇总数量/金额；跨 SKU 只聚合无量纲偏差百分比的中位数。
 */
export function calculateSupplierPriceVariance(observations: PurchasePriceObservation[]): {
  rows: SupplierPriceVarianceRow[];
  supplierSummary: SupplierPriceVarianceSummaryRow[];
  counts: Omit<SupplierPriceVarianceResult["summary"], "windowDays" | "asOf">;
} {
  const grouped = new Map<string, SupplierSkuAggregate>();
  let validLineCount = 0;
  let excludedInvalidLineCount = 0;

  for (const line of observations) {
    try {
      if (dCmp(line.qty, "0") <= 0 || dCmp(line.price, "0") <= 0 || dCmp(line.uomFactor, "0") <= 0) {
        excludedInvalidLineCount += 1;
        continue;
      }
      const orderedBaseQty = dQty(dMul(line.qty, line.uomFactor, 6));
      const baseNetPrice = normalizeToBaseNet({
        price: line.price,
        taxIncluded: line.taxIncluded,
        taxRatePct: line.taxRatePct,
        uomFactor: line.uomFactor,
      });
      if (dCmp(orderedBaseQty, "0") <= 0 || dCmp(baseNetPrice, "0") <= 0) {
        excludedInvalidLineCount += 1;
        continue;
      }
      const orderedNetValue = dMul(orderedBaseQty, baseNetPrice, 6);
      const key = `${line.supplierId}:${line.skuId}`;
      const current = grouped.get(key);
      if (current) {
        current.lineCount += 1;
        current.orderedBaseQty = dQty(dAdd(current.orderedBaseQty, orderedBaseQty, 6));
        current.orderedNetValue = dAdd(current.orderedNetValue, orderedNetValue, 6);
        current.averageBaseNetPrice = dMoney(dDiv(current.orderedNetValue, current.orderedBaseQty, 6));
      } else {
        grouped.set(key, {
          supplierId: line.supplierId,
          supplierCode: line.supplierCode,
          supplierName: line.supplierName,
          skuId: line.skuId,
          skuCode: line.skuCode,
          skuName: line.skuName,
          baseUom: line.baseUom,
          lineCount: 1,
          orderedBaseQty,
          orderedNetValue,
          averageBaseNetPrice: dMoney(dDiv(orderedNetValue, orderedBaseQty, 6)),
        });
      }
      validLineCount += 1;
    } catch (error) {
      if (error instanceof PriceRuleError) {
        excludedInvalidLineCount += 1;
        continue;
      }
      throw error;
    }
  }

  const bySku = new Map<number, SupplierSkuAggregate[]>();
  for (const group of grouped.values()) {
    const list = bySku.get(group.skuId) ?? [];
    list.push(group);
    bySku.set(group.skuId, list);
  }

  const rows: SupplierPriceVarianceRow[] = [];
  let singleSupplierLineCount = 0;
  for (const groups of bySku.values()) {
    if (groups.length < 2) {
      singleSupplierLineCount += groups.reduce((sum, group) => sum + group.lineCount, 0);
      continue;
    }
    const benchmark = groups.reduce(
      (best, group) => (dCmp(group.averageBaseNetPrice, best) < 0 ? group.averageBaseNetPrice : best),
      groups[0].averageBaseNetPrice,
    );
    for (const group of groups) {
      rows.push({
        key: `${group.supplierId}:${group.skuId}`,
        supplierId: group.supplierId,
        supplierCode: group.supplierCode,
        supplierName: group.supplierName,
        skuId: group.skuId,
        skuCode: group.skuCode,
        skuName: group.skuName,
        baseUom: group.baseUom,
        currency: "CNY",
        lineCount: group.lineCount,
        orderedBaseQty: group.orderedBaseQty,
        averageBaseNetPrice: group.averageBaseNetPrice,
        benchmarkBaseNetPrice: benchmark,
        variancePct: dDeviationPct(benchmark, group.averageBaseNetPrice),
        isBenchmark: dCmp(group.averageBaseNetPrice, benchmark) === 0,
      });
    }
  }

  rows.sort((a, b) => dCmp(b.variancePct, a.variancePct) || a.skuCode.localeCompare(b.skuCode) || a.supplierCode.localeCompare(b.supplierCode));

  const supplierSummary = summarizeSupplierRows(rows);

  const comparableLineCount = rows.reduce((sum, row) => sum + row.lineCount, 0);
  const comparableSkuCount = new Set(rows.map((row) => row.skuId)).size;
  return {
    rows,
    supplierSummary,
    counts: {
      inputLineCount: observations.length,
      validLineCount,
      comparableLineCount,
      excludedInvalidLineCount,
      singleSupplierLineCount,
      comparableSkuCount,
      comparableSupplierCount: supplierSummary.length,
      coveragePct: observations.length > 0 ? dMul(dDiv(comparableLineCount, observations.length, 6), "100", 2) : "0.00",
    },
  };
}

const shanghaiDate = shanghaiDayOf;

export async function getSupplierPriceVariance(
  query: { q?: string; page?: number; pageSize?: number; windowDays?: number; asOf?: Date },
  dbArg?: AnyDb,
): Promise<SupplierPriceVarianceResult> {
  const db = await resolveDb(dbArg);
  const asOf = query.asOf ?? new Date();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(5001, Math.max(1, query.pageSize ?? 20));
  const windowDays = Math.min(1095, Math.max(30, query.windowDays ?? DEFAULT_PRICE_VARIANCE_WINDOW_DAYS));
  const cutoff = new Date(asOf.getTime() - windowDays * 86_400_000);

  const observations: PurchasePriceObservation[] = await db
    .select({
      lineId: schema.poLines.id,
      supplierId: schema.poDocs.supplierId,
      supplierCode: schema.suppliers.code,
      supplierName: schema.suppliers.name,
      skuId: schema.poLines.skuId,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      baseUom: schema.skus.baseUom,
      qty: schema.poLines.qty,
      uomFactor: schema.poLines.uomFactor,
      price: schema.poLines.price,
      taxIncluded: schema.poLines.taxIncluded,
      taxRatePct: schema.poLines.taxRatePct,
    })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .innerJoin(schema.suppliers, eq(schema.poDocs.supplierId, schema.suppliers.id))
    .innerJoin(schema.skus, eq(schema.poLines.skuId, schema.skus.id))
    .where(and(
      inArray(schema.poDocs.status, [...EFFECTIVE_PO_STATUSES]),
      gte(schema.poDocs.createdAt, cutoff),
    ));

  const calculated = calculateSupplierPriceVariance(observations);
  const q = (query.q ?? "").trim().toLowerCase();
  const filtered = q
    ? calculated.rows.filter((row) => [row.supplierCode, row.supplierName, row.skuCode, row.skuName]
      .some((value) => value.toLowerCase().includes(q)))
    : calculated.rows;

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    // 图表与明细必须遵循同一搜索范围；覆盖率/KPI 仍保留完整时间窗口作为数据质量基数。
    supplierSummary: q ? summarizeSupplierRows(filtered) : calculated.supplierSummary,
    summary: {
      ...calculated.counts,
      windowDays,
      asOf: shanghaiDate(asOf),
    },
    readiness: {
      level: "observation",
      decisionReady: false,
      currencyState: "system_default_not_line_level",
      yonyouSupplierIdentityState: "uat_required",
      blockers: [
        "PO 行尚未显式记录币种；当前 CNY 只是系统采购基准币种约定，不能证明每张外部凭证币种。",
        "用友供应商权威身份尚未完成真实账号读取、映射例外清零与业务 UAT。",
      ],
      permittedUse: "用于发现同 SKU、同基础单位、同未税口径下值得采购复核的价格信号。",
      prohibitedUse: "不得直接用于财务定价、自动供应商排名、停用供应商或自动改变付款条件。",
    },
  };
}
