import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { jgDocs, jsDocs, suppliers } from "@/db/schema";
import { dAdd, dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";
import type { DocStatus } from "@/server/docflow/state";

/**
 * 结算汇总表（《02》§2.1-10 报表 4 张之一）——金额报表，角色门禁：
 * 采购/PMC/财务（admin 兜底），运营/仓管 403（R9：金额对其不可见，整表拒绝而非脱敏）。
 * 口径：JS 单 status ∈ {pending, completed}（草稿不计；驳回回草稿自动出表）；
 * 时间窗按 JS 创建时间（Asia/Shanghai 日期字符串入参，闭区间）；金额直接取 js_docs
 * 落库值（数学唯一权威 rules/settlement.ts 已在开单时固化）。
 */

export const SETTLEMENT_SUMMARY_ROLES = ["purchasing", "pmc", "finance"] as const;

const SUMMARY_STATUSES: DocStatus[] = ["pending", "completed"];

export interface SettlementSummaryDoc {
  jsId: number;
  jsNo: string;
  jgNo: string;
  supplierId: number;
  supplierName: string;
  goodQty: string;
  concessionQty: string;
  spareQty: string;
  feePayable: string;
  deductionTotal: string;
  settleAmount: string;
  status: string;
  createdAt: Date;
}

export interface SettlementSupplierRow {
  supplierId: number;
  supplierName: string;
  jsCount: number;
  feePayable: string;
  deductionTotal: string;
  settleAmount: string;
}

export interface SettlementSummary {
  bySupplier: SettlementSupplierRow[];
  docs: SettlementSummaryDoc[];
}

export async function getSettlementSummary(
  user: SessionUser,
  opts: { from?: string; to?: string; supplierId?: number; status?: string } = {},
  dbArg?: AnyDb,
): Promise<SettlementSummary> {
  requireAnyRole(user, ...SETTLEMENT_SUMMARY_ROLES);
  const db = await resolveDb(dbArg);

  if (opts.status && !SUMMARY_STATUSES.includes(opts.status as DocStatus)) {
    throw new ApiError(400, `无效的状态筛选: ${opts.status}（仅 pending/completed）`);
  }
  const conds = [
    opts.status
      ? eq(jsDocs.status, opts.status as DocStatus)
      : inArray(jsDocs.status, SUMMARY_STATUSES),
  ];
  // 业务日期 Asia/Shanghai：from/to 为 YYYY-MM-DD，转当日边界（+08:00）闭区间
  if (opts.from) conds.push(gte(jsDocs.createdAt, new Date(`${opts.from}T00:00:00+08:00`)));
  if (opts.to) conds.push(lte(jsDocs.createdAt, new Date(`${opts.to}T23:59:59.999+08:00`)));
  if (opts.supplierId) conds.push(eq(jgDocs.supplierId, opts.supplierId));

  const docs: SettlementSummaryDoc[] = await db
    .select({
      jsId: jsDocs.id,
      jsNo: jsDocs.docNo,
      jgNo: jgDocs.docNo,
      supplierId: jgDocs.supplierId,
      supplierName: suppliers.name,
      goodQty: jsDocs.goodQty,
      concessionQty: jsDocs.concessionQty,
      spareQty: jsDocs.spareQty,
      feePayable: jsDocs.feePayable,
      deductionTotal: jsDocs.deductionTotal,
      settleAmount: jsDocs.settleAmount,
      status: jsDocs.status,
      createdAt: jsDocs.createdAt,
    })
    .from(jsDocs)
    .innerJoin(jgDocs, eq(jsDocs.jgId, jgDocs.id))
    .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
    .where(and(...conds))
    .orderBy(desc(jsDocs.createdAt), desc(jsDocs.id));

  // 按供应商归集（decimal 工具累加，scale=2；禁 float）
  const bySupplierMap = new Map<number, SettlementSupplierRow>();
  for (const d of docs) {
    const acc = bySupplierMap.get(d.supplierId);
    if (!acc) {
      bySupplierMap.set(d.supplierId, {
        supplierId: d.supplierId,
        supplierName: d.supplierName,
        jsCount: 1,
        feePayable: dAdd("0", d.feePayable, 2),
        deductionTotal: dAdd("0", d.deductionTotal, 2),
        settleAmount: dAdd("0", d.settleAmount, 2),
      });
    } else {
      acc.jsCount += 1;
      acc.feePayable = dAdd(acc.feePayable, d.feePayable, 2);
      acc.deductionTotal = dAdd(acc.deductionTotal, d.deductionTotal, 2);
      acc.settleAmount = dAdd(acc.settleAmount, d.settleAmount, 2);
    }
  }
  const bySupplier = [...bySupplierMap.values()].sort((a, b) =>
    a.supplierName.localeCompare(b.supplierName, "zh-CN"),
  );

  return { bySupplier, docs: docs.map((d) => ({ ...d, goodQty: dQty(d.goodQty), concessionQty: dQty(d.concessionQty), spareQty: dQty(d.spareQty) })) };
}
