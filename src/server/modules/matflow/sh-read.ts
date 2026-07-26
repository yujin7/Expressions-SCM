import { and, desc, eq, sql } from "drizzle-orm";
import {
  jgDocs,
  poDocs,
  qcLines,
  qcRecords,
  shDocs,
  shLines,
  skus,
  users,
  warehouses,
} from "@/db/schema";
import { loadApprovalHistory } from "@/server/docflow/approval";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, resolveDb } from "@/server/modules/outsource/common";
import type { DocStatus } from "@/server/docflow/state";

type QcRecordRow = typeof qcRecords.$inferSelect;

export async function getSh(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: shDocs.id,
      docNo: shDocs.docNo,
      status: shDocs.status,
      remark: shDocs.remark,
      version: shDocs.version,
      sourceType: shDocs.sourceType,
      sourceId: shDocs.sourceId,
      warehouseId: shDocs.warehouseId,
      warehouseName: warehouses.name,
      createdBy: shDocs.createdBy,
      createdAt: shDocs.createdAt,
      createdByName: users.name,
    })
    .from(shDocs)
    .innerJoin(warehouses, eq(shDocs.warehouseId, warehouses.id))
    .leftJoin(users, eq(shDocs.createdBy, users.id))
    .where(eq(shDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  let sourceDocNo: string | null = null;
  if (doc.sourceType === "jg") {
    const [row]: { docNo: string }[] = await db
      .select({ docNo: jgDocs.docNo })
      .from(jgDocs)
      .where(eq(jgDocs.id, doc.sourceId));
    sourceDocNo = row?.docNo ?? null;
  } else {
    const [row]: { docNo: string }[] = await db
      .select({ docNo: poDocs.docNo })
      .from(poDocs)
      .where(eq(poDocs.id, doc.sourceId));
    sourceDocNo = row?.docNo ?? null;
  }

  const lines = await db
    .select({
      id: shLines.id,
      skuId: shLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      lineType: shLines.lineType,
      expectedQty: shLines.expectedQty,
      actualQty: shLines.actualQty,
      batchNo: shLines.batchNo,
      prodDate: shLines.prodDate,
    })
    .from(shLines)
    .innerJoin(skus, eq(shLines.skuId, skus.id))
    .where(eq(shLines.shId, id))
    .orderBy(shLines.id);

  const [qcRow]: QcRecordRow[] = await db.select().from(qcRecords).where(eq(qcRecords.shId, id));
  const qc = qcRow
    ? {
        id: qcRow.id,
        conclusion: qcRow.conclusion,
        createdAt: qcRow.createdAt,
        lines: await db
          .select({
            id: qcLines.id,
            shLineId: qcLines.shLineId,
            passQty: qcLines.passQty,
            failQty: qcLines.failQty,
            concessionQty: qcLines.concessionQty,
            failHandling: qcLines.failHandling,
          })
          .from(qcLines)
          .where(eq(qcLines.qcId, qcRow.id))
          .orderBy(qcLines.id),
      }
    : null;

  return {
    ...doc,
    sourceDocNo,
    lines,
    qc,
    inbound: doc.status === "completed",
    approvals: await loadApprovalHistory(db, "sh", id),
  };
}

export async function listShs(
  q: string,
  opts: { status?: string; sourceType?: string; sourceId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(sql`${shDocs.docNo} ILIKE ${"%" + q + "%"}`);
  if (opts.status) conds.push(eq(shDocs.status, opts.status as DocStatus));
  if (opts.sourceType) conds.push(eq(shDocs.sourceType, opts.sourceType));
  if (opts.sourceId) conds.push(eq(shDocs.sourceId, opts.sourceId));
  const where = conds.length ? and(...conds) : undefined;

  const lineAgg = db
    .select({ shId: shLines.shId, lineCount: sql<number>`count(*)::int`.as("agg_line_count") })
    .from(shLines)
    .groupBy(shLines.shId)
    .as("la");
  const qcAgg = db
    .select({ shId: qcRecords.shId, qcId: sql<number>`min(${qcRecords.id})`.as("agg_qc_id") })
    .from(qcRecords)
    .groupBy(qcRecords.shId)
    .as("qa");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: shDocs.id,
        docNo: shDocs.docNo,
        status: shDocs.status,
        sourceType: shDocs.sourceType,
        sourceId: shDocs.sourceId,
        sourceDocNo: sql<string | null>`case when ${shDocs.sourceType} = 'po' then ${poDocs.docNo} else ${jgDocs.docNo} end`,
        warehouseName: warehouses.name,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        hasQc: sql<boolean>`${qcAgg.qcId} is not null`,
        inbound: sql<boolean>`${shDocs.status} = 'completed'`,
        createdByName: users.name,
        createdAt: shDocs.createdAt,
      })
      .from(shDocs)
      .leftJoin(poDocs, and(eq(shDocs.sourceType, sql`'po'`), eq(shDocs.sourceId, poDocs.id)))
      .leftJoin(jgDocs, and(eq(shDocs.sourceType, sql`'jg'`), eq(shDocs.sourceId, jgDocs.id)))
      .innerJoin(warehouses, eq(shDocs.warehouseId, warehouses.id))
      .leftJoin(lineAgg, eq(lineAgg.shId, shDocs.id))
      .leftJoin(qcAgg, eq(qcAgg.shId, shDocs.id))
      .leftJoin(users, eq(shDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(shDocs.createdAt), desc(shDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(shDocs).where(where),
  ]);
  return { rows, total };
}
