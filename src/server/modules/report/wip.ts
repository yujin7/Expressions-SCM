import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  flDocs, flLines, jgDocs, qcLines, qcRecords, shDocs, shLines, skus, suppliers, woDocs,
} from "@/db/schema";
import { dAdd, dCmp, dDiv, dMax, dMul, dSub } from "@/server/core/decimal";
import { todayShanghai } from "@/server/modules/master/common";
import { type AnyDb, resolveDb } from "@/server/modules/outsource/common";

/**
 * 委外在制看板（《02》§2.1-10 报表；无金额列——运营/仓管可看）。
 * 口径与 matflow/sh.ts、settlement/js.ts 对齐：
 * - receivedGood/Concession：已入库（SH completed）的 QC 合格/让步，仅 normal+rework 行
 *   （备品行不占 JG 数量，js.ts previewJs 同口径）；
 * - pendingQty = JG数量 − Σ已生效（approved/in_progress/completed）SH **正常行**实收
 *   （返工重交冲抵原不合格、备品不占累计——与 sh.ts jgReceiptCum 分子一致）；
 * - issuedMaterialLines：已过账（approved/completed）FL 的发料行数；
 * - overdue：dueDate < 今日（Asia/Shanghai）且状态为 approved/in_progress。
 */

/** 与 matflow/common-notes ACTIVE_DOC_STATUSES 一致（避免跨模块 const 数组类型摩擦，就地声明） */
const ACTIVE_SH_STATUSES = ["approved", "in_progress", "completed"] as const;
const POSTED_FL_STATUSES = ["approved", "completed"] as const;
const NON_SPARE_TYPES = ["normal", "rework"] as const;

export interface WipRow {
  jgId: number;
  jgNo: string;
  woNo: string;
  woId: number;
  supplierId: number;
  supplierName: string;
  productSkuCode: string;
  productName: string;
  orderQty: string;
  receivedGood: string;
  receivedConcession: string;
  pendingQty: string;
  overReceivedQty: string;
  inWip: boolean;
  baseUom: string;
  issuedMaterialLines: number;
  status: string;
  dueDate: string | null;
  overdue: boolean;
}

export interface WipSummary {
  /** 在制（状态 ∉ completed/closed）JG 数 */
  wipCount: number;
  overdueCount: number;
  /** 待收总量 = Σ max(0, pendingQty)，仅在制 JG */
  pendingTotal: string;
}

export interface WipSupplier {
  supplierId: number; name: string; pending: string; jobs: number; overdue: number;
  sharePct: number; relativePct: number;
}
export interface WipResult { rows: WipRow[]; summary: WipSummary; suppliers: WipSupplier[] }

export async function listWip(
  opts: { supplierId?: number; overdueOnly?: boolean } = {},
  dbArg?: AnyDb,
): Promise<WipResult> {
  const db = await resolveDb(dbArg);
  return db.transaction((tx: AnyDb) => buildWip(opts, tx), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function buildWip(opts: { supplierId?: number; overdueOnly?: boolean }, db: AnyDb): Promise<WipResult> {
  const conds = [inArray(jgDocs.status, ["approved", "in_progress", "completed", "closed"])];
  if (opts.supplierId) conds.push(eq(jgDocs.supplierId, opts.supplierId));

  const jgRows: {
    id: number; docNo: string; status: string; qty: string; dueDate: string | null;
    supplierId: number; supplierName: string; woNo: string;
    productSkuCode: string; productName: string; woId: number; baseUom: string;
  }[] = await db
    .select({
      id: jgDocs.id,
      docNo: jgDocs.docNo,
      status: jgDocs.status,
      qty: jgDocs.qty,
      dueDate: jgDocs.dueDate,
      supplierId: jgDocs.supplierId,
      supplierName: suppliers.name,
      woNo: woDocs.docNo,
      woId: woDocs.id,
      baseUom: skus.baseUom,
      productSkuCode: skus.code,
      productName: skus.name,
    })
    .from(jgDocs)
    .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
    .innerJoin(woDocs, eq(jgDocs.woId, woDocs.id))
    .innerJoin(skus, eq(jgDocs.productSkuId, skus.id))
    .where(and(...conds))
    .orderBy(asc(jgDocs.dueDate), desc(jgDocs.id));

  if (jgRows.length === 0) {
    return { rows: [], summary: { wipCount: 0, overdueCount: 0, pendingTotal: "0" }, suppliers: [] };
  }
  const jgIds = jgRows.map((r) => r.id);

  // Σ 正常行实收（已生效 SH）——pendingQty 分子（与 sh.ts jgReceiptCum 同口径）
  const normalAgg: { jgId: number; qty: string | null }[] = await db
    .select({ jgId: shDocs.sourceId, qty: sql<string | null>`sum(${shLines.actualQty})` })
    .from(shLines)
    .innerJoin(shDocs, eq(shLines.shId, shDocs.id))
    .innerJoin(jgDocs, and(eq(shDocs.sourceId, jgDocs.id), eq(shLines.skuId, jgDocs.productSkuId)))
    .where(and(
      eq(shDocs.sourceType, "jg"),
      inArray(shDocs.sourceId, jgIds),
      inArray(shDocs.status, [...ACTIVE_SH_STATUSES]),
      eq(shLines.lineType, "normal"),
    ))
    .groupBy(shDocs.sourceId);
  const normalByJg = new Map(normalAgg.map((r) => [r.jgId, r.qty ?? "0"]));

  // 已入库（completed SH）QC 合格/让步（normal+rework 行；spare 不计）
  const qcAgg: { jgId: number; pass: string | null; concession: string | null }[] = await db
    .select({
      jgId: shDocs.sourceId,
      pass: sql<string | null>`sum(${qcLines.passQty})`,
      concession: sql<string | null>`sum(${qcLines.concessionQty})`,
    })
    .from(qcLines)
    .innerJoin(qcRecords, eq(qcLines.qcId, qcRecords.id))
    .innerJoin(shDocs, eq(qcRecords.shId, shDocs.id))
    .innerJoin(shLines, eq(qcLines.shLineId, shLines.id))
    .innerJoin(jgDocs, and(eq(shDocs.sourceId, jgDocs.id), eq(shLines.skuId, jgDocs.productSkuId)))
    .where(and(
      eq(shDocs.sourceType, "jg"),
      inArray(shDocs.sourceId, jgIds),
      eq(shDocs.status, "completed"),
      eq(shLines.shId, shDocs.id),
      inArray(shLines.lineType, [...NON_SPARE_TYPES]),
    ))
    .groupBy(shDocs.sourceId);
  const qcByJg = new Map(qcAgg.map((r) => [r.jgId, r]));

  // 已过账 FL 发料行数
  const flAgg: { jgId: number; lineCount: number }[] = await db
    .select({ jgId: flDocs.jgId, lineCount: sql<number>`count(*)::int` })
    .from(flLines)
    .innerJoin(flDocs, eq(flLines.flId, flDocs.id))
    .where(and(inArray(flDocs.jgId, jgIds), inArray(flDocs.status, [...POSTED_FL_STATUSES])))
    .groupBy(flDocs.jgId);
  const flByJg = new Map(flAgg.map((r) => [r.jgId, r.lineCount]));

  const today = todayShanghai();
  let rows: WipRow[] = jgRows.map((jg) => {
    const qc = qcByJg.get(jg.id);
    const pendingQty = dSub(jg.qty, normalByJg.get(jg.id) ?? "0");
    const inWip = jg.status === "approved" || jg.status === "in_progress";
    return {
      jgId: jg.id,
      jgNo: jg.docNo,
      woNo: jg.woNo,
      woId: jg.woId,
      baseUom: jg.baseUom,
      supplierId: jg.supplierId,
      supplierName: jg.supplierName,
      productSkuCode: jg.productSkuCode,
      productName: jg.productName,
      orderQty: jg.qty,
      receivedGood: qc?.pass ?? "0",
      receivedConcession: qc?.concession ?? "0",
      pendingQty: dMax(pendingQty, "0"),
      overReceivedQty: dMax(dSub("0", pendingQty), "0"),
      inWip,
      issuedMaterialLines: flByJg.get(jg.id) ?? 0,
      status: jg.status,
      dueDate: jg.dueDate,
      overdue: jg.dueDate != null && jg.dueDate < today && inWip,
    };
  });

  if (opts.overdueOnly) rows = rows.filter((r) => r.overdue);
  // 图、卡和行共享当前筛选；已完成/短关可查，但不冒充在制。
  const wipRows = rows.filter((r) => r.inWip);
  let pendingTotal = "0";
  for (const r of wipRows) {
    if (dCmp(r.pendingQty, "0") > 0) pendingTotal = dAdd(pendingTotal, r.pendingQty);
  }
  const summary: WipSummary = {
    wipCount: wipRows.length,
    overdueCount: rows.filter((r) => r.overdue).length,
    pendingTotal,
  };

  const bySupplier = new Map<number, WipSupplier>();
  for (const row of wipRows) {
    const group = bySupplier.get(row.supplierId) ?? { supplierId: row.supplierId, name: row.supplierName,
      pending: "0.0000", jobs: 0, overdue: 0, sharePct: 0, relativePct: 0 };
    group.pending = dAdd(group.pending, row.pendingQty);
    group.jobs++; group.overdue += Number(row.overdue);
    bySupplier.set(row.supplierId, group);
  }
  const groups = [...bySupplier.values()].sort((a, b) => dCmp(b.pending, a.pending) || a.supplierId - b.supplierId);
  const max = groups[0]?.pending ?? "0";
  for (const group of groups) {
    group.sharePct = dCmp(pendingTotal, "0") > 0 ? Number(dMul(dDiv(group.pending, pendingTotal, 6), "100", 1)) : 0;
    group.relativePct = dCmp(max, "0") > 0 ? Number(dMul(dDiv(group.pending, max, 6), "100", 1)) : 0;
  }
  return { rows, summary, suppliers: groups };
}
