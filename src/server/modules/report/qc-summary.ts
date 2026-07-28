/**
 * E5-07 质检聚合透视（只读报表）。
 *
 * 现状：质检数据只进不出——逐单 qc_records/qc_lines 记得很全，却没有任何聚合能回答
 * 「哪家供应商这季度让步接收率最高」。检验在系统里成了终点，而不是反馈回路。
 * 本模块按 (供应商 × 月) 透视质检结果，供 E5-06 记分卡页面的「质检透视」页签使用。
 *
 * ── 口径（与 report/supplier-scorecard.ts 完全一致）──
 * · 归属月份 = qc_records.created_at 的 Asia/Shanghai 年月（检验发生月，不是收货月/入库月）；
 * · 收货批次数 batches = 该 (供应商, 月) 下**去重的收货单张数**（一单一检，故等于检验单数）；
 * · 五类判定：正常=passQty；返工/让步/报废/待判定 = failQty 按 fail_handling 归类
 *   （qc_handling 枚举实际取值：pending / rework / concession / scrap），
 *   另有独立的 concessionQty 桶并入「让步」；
 * · 占比分母 = 判定总量 graded = pass + fail + concession（未检验的量不进分母）；
 * · 生效收货状态 = approved/in_progress/completed（照抄 report/wip.ts ACTIVE_SH_STATUSES）；
 * · PO 收货与 JG 委外收货都算，供应商分别取自 po_docs / jg_docs。
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { lastMonths } from "@/server/core/velocity";
import { todayShanghai } from "@/server/modules/master/common";
import { num } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTable = any;

const ACTIVE_SH_STATUSES = ["approved", "in_progress", "completed"] as const;

/** 默认透视月数 */
export const DEFAULT_MONTHS = 6;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/** 时间戳 → Asia/Shanghai 年月 YYYY-MM */
function shanghaiMonth(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d).slice(0, 7);
}

export interface QcSummaryRow {
  supplierId: number;
  code: string;
  name: string;
  /** YYYY-MM（检验月，Asia/Shanghai） */
  month: string;
  /** 收货批次数（去重收货单张数） */
  batches: number;
  passQty: number;
  reworkQty: number;
  concessionQty: number;
  scrapQty: number;
  pendingQty: number;
  /** 判定总量 = pass + fail + concession */
  gradedQty: number;
  passRate: number | null;
  reworkRate: number | null;
  concessionRate: number | null;
  scrapRate: number | null;
  pendingRate: number | null;
}

export interface QcSummary {
  rows: QcSummaryRow[];
  /** 全窗口合计（同结构，supplierId=0 / month="" 占位） */
  totals: Omit<QcSummaryRow, "supplierId" | "code" | "name" | "month">;
  /** 参与透视的月份（升序，含无数据的空月） */
  months: string[];
}

interface Bucket {
  shIds: Set<number>;
  pass: number;
  rework: number;
  concession: number;
  scrap: number;
  pending: number;
  graded: number;
}
const emptyBucket = (): Bucket => ({ shIds: new Set(), pass: 0, rework: 0, concession: 0, scrap: 0, pending: 0, graded: 0 });

const rate = (part: number, whole: number): number | null => (whole > 0 ? r4(part / whole) : null);

export async function getQcSummary(
  query: { supplierId?: number; months?: number },
  dbArg?: AnyDb,
): Promise<QcSummary> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const monthCount = Math.min(36, Math.max(1, query.months ?? DEFAULT_MONTHS));
  const months = lastMonths(todayShanghai().slice(0, 7), monthCount);
  // 窗口起点 = 首月 1 日 00:00（Asia/Shanghai = UTC+8）
  const cutoff = new Date(`${months[0]}-01T00:00:00+08:00`);

  /** 逐行取数（不在 SQL 里做时区分月，避免 PGlite/PG 方言差异；行量为「检验行×窗口月」，可控） */
  const fetch = async (
    sourceType: string,
    doc: AnyTable,
  ): Promise<{
    supplierId: number;
    shId: number;
    inspectedAt: Date;
    handling: string;
    pass: string;
    fail: string;
    concession: string;
  }[]> => {
    const conds = [
      eq(schema.shDocs.sourceType, sourceType),
      inArray(schema.shDocs.status, [...ACTIVE_SH_STATUSES]),
      gte(schema.qcRecords.createdAt, cutoff),
    ];
    if (query.supplierId) conds.push(eq(doc.supplierId, query.supplierId));
    return db
      .select({
        supplierId: doc.supplierId,
        shId: schema.shDocs.id,
        inspectedAt: schema.qcRecords.createdAt,
        handling: schema.qcLines.failHandling,
        pass: schema.qcLines.passQty,
        fail: schema.qcLines.failQty,
        concession: schema.qcLines.concessionQty,
      })
      .from(schema.qcLines)
      .innerJoin(schema.qcRecords, eq(schema.qcLines.qcId, schema.qcRecords.id))
      .innerJoin(schema.shDocs, eq(schema.qcRecords.shId, schema.shDocs.id))
      .innerJoin(doc, eq(schema.shDocs.sourceId, doc.id))
      .where(and(...conds));
  };

  const lines = [...(await fetch("po", schema.poDocs)), ...(await fetch("jg", schema.jgDocs))];
  const monthSet = new Set(months);

  const byKey = new Map<string, { supplierId: number; month: string; b: Bucket }>();
  const totalB = emptyBucket();
  for (const l of lines) {
    const month = shanghaiMonth(new Date(l.inspectedAt));
    if (!monthSet.has(month)) continue; // 起点取整月，边界外的行剔除
    const key = `${l.supplierId}|${month}`;
    const cur = byKey.get(key) ?? { supplierId: l.supplierId, month, b: emptyBucket() };
    const pass = num(l.pass);
    const fail = num(l.fail);
    const conc = num(l.concession);
    for (const b of [cur.b, totalB]) {
      b.shIds.add(l.shId);
      b.pass += pass;
      b.concession += conc;
      if (l.handling === "rework") b.rework += fail;
      else if (l.handling === "concession") b.concession += fail;
      else if (l.handling === "scrap") b.scrap += fail;
      else b.pending += fail; // pending
      b.graded += pass + fail + conc;
    }
    byKey.set(key, cur);
  }

  const supplierIds = [...new Set([...byKey.values()].map((v) => v.supplierId))];
  const supRows: { id: number; code: string; name: string }[] = supplierIds.length
    ? await db
        .select({ id: schema.suppliers.id, code: schema.suppliers.code, name: schema.suppliers.name })
        .from(schema.suppliers)
        .where(inArray(schema.suppliers.id, supplierIds))
    : [];
  const supById = new Map(supRows.map((s) => [s.id, s]));

  const toRow = (b: Bucket) => ({
    batches: b.shIds.size,
    passQty: r2(b.pass),
    reworkQty: r2(b.rework),
    concessionQty: r2(b.concession),
    scrapQty: r2(b.scrap),
    pendingQty: r2(b.pending),
    gradedQty: r2(b.graded),
    passRate: rate(b.pass, b.graded),
    reworkRate: rate(b.rework, b.graded),
    concessionRate: rate(b.concession, b.graded),
    scrapRate: rate(b.scrap, b.graded),
    pendingRate: rate(b.pending, b.graded),
  });

  const rows: QcSummaryRow[] = [...byKey.values()].map((v) => {
    const sup = supById.get(v.supplierId);
    return {
      supplierId: v.supplierId,
      code: sup?.code ?? `#${v.supplierId}`,
      name: sup?.name ?? `#${v.supplierId}`,
      month: v.month,
      ...toRow(v.b),
    };
  });
  // 月份升序 → 同月内让步+报废占比高的在前（问题优先）
  rows.sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      (b.concessionRate ?? 0) + (b.scrapRate ?? 0) - ((a.concessionRate ?? 0) + (a.scrapRate ?? 0)) ||
      a.code.localeCompare(b.code),
  );

  return { rows, totals: toRow(totalB), months };
}
