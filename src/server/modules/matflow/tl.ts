import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
   flDocs, flLines, jgDocs, skus, tlDocs, tlLines, users, warehouses,
} from "@/db/schema";
import { dAdd, dCmp, dNeg, dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approveDoc, loadApprovalHistory } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import type { DocStatus } from "@/server/docflow/state";
import { post, PostingError } from "@/server/posting";
import { ApiError } from "@/server/modules/master/common";
import {
  type AnyDb, requireAnyRole, resolveDb, rethrowApproval,
} from "@/server/modules/outsource/common";
import { approveDocSchema } from "@/server/modules/outsource/schemas";
import {
  ACTIVE_DOC_STATUSES, completeApprovedDoc, getJgForMatflow, getOutsourceWarehouseOf,
  requireRealtimeWarehouse,
} from "./common-notes";
import { createTlSchema } from "./schemas";
import { expandOutboundLinesForBatchPosting } from "@/server/modules/inventory/batch-allocation";

/**
 * 委外退料单 TL（R5「退回量」唯一数据源）：委外仓 → 自有仓。
 * MVP 守卫（审批时点）：逐物料 累计TL ≤ 累计FL（不含在制消耗——诚实近似，
 * 精确口径待 JS 结算按净标准用量核，W5）；违反 409。
 * 过账 tl_return：委外仓 −，自有仓 +，审批即瞬时执行完成。
 */

type TlRow = typeof tlDocs.$inferSelect;
type TlLineRow = typeof tlLines.$inferSelect;

// ---------- 创建 ----------

export async function createTl(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<TlRow> {
  requireAnyRole(user, "warehouse");
  const v = createTlSchema.parse(input);
  const db = await resolveDb(dbArg);

  const jg = await getJgForMatflow(db, v.jgId);
  const fromWh = await getOutsourceWarehouseOf(db, jg.supplierId); // 退料出仓=该加工厂委外仓（自动）
  await requireRealtimeWarehouse(db, v.toWarehouseId, "退回仓");

  const skuIds = [...new Set(v.lines.map((l) => l.skuId))];
  const skuRows: { id: number; active: boolean }[] = await db
    .select({ id: skus.id, active: skus.active })
    .from(skus)
    .where(inArray(skus.id, skuIds));
  const activeSku = new Set(skuRows.filter((s) => s.active).map((s) => s.id));
  for (const sid of skuIds) {
    if (!activeSku.has(sid)) throw new ApiError(400, `SKU 不存在或已停用: #${sid}`);
  }

  return db.transaction(async (tx: AnyDb) => {
    const allocatedLines = await expandOutboundLinesForBatchPosting(tx, fromWh.id, v.lines);
    const docNo = await nextDocNo(tx, "TL");
    const [doc]: TlRow[] = await tx
      .insert(tlDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        jgId: jg.id,
        fromWarehouseId: fromWh.id,
        toWarehouseId: v.toWarehouseId,
        createdBy: user.id,
      })
      .returning();
    await tx.insert(tlLines).values(
      allocatedLines.map((l) => ({
        tlId: doc.id,
        skuId: l.skuId,
        qty: dQty(l.qty),
        batchId: l.batchId,
        reason: l.reason,
      })),
    );
    await writeAudit(tx, {
      userId: user.id, entity: "tl", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, jgId: jg.id, fromWarehouseId: fromWh.id, lineCount: allocatedLines.length },
    });
    return doc;
  });
}

// ---------- 提交 ----------

export async function submitTl(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<TlRow> {
  const db = await resolveDb(dbArg);
  const [doc]: TlRow[] = await db.select().from(tlDocs).where(eq(tlDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  if (doc.createdBy !== user.id && !user.roles.includes("warehouse") && !user.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/仓管/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  const updated: TlRow[] = await db
    .update(tlDocs)
    .set({ status: "pending", version: sql`${tlDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(tlDocs.id, id), eq(tlDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "tl", entityId: id, action: "submit" });
  return updated[0];
}

// ---------- 审批（TL≤FL 守卫 + 过账 tl_return，同一事务） ----------

export async function approveTl(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const [doc]: TlRow[] = await tx.select().from(tlDocs).where(eq(tlDocs.id, id));
      if (!doc) throw new ApiError(404, "单据不存在");

      const r = await approveDoc(tx, {
        docType: "tl",
        table: tlDocs,
        docId: id,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "tl", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      if (v.action === "reject") return r;

      const lines: TlLineRow[] = await tx.select().from(tlLines).where(eq(tlLines.tlId, id)).orderBy(tlLines.id);
      if (lines.length === 0) throw new ApiError(409, "退料单无行，不可审批过账");

      // MVP 守卫：逐物料 累计TL（他单已生效+本单） ≤ 累计FL（已生效）
      const issued = await sumByskuOf(tx, "fl", doc.jgId);
      const returned = await sumByskuOf(tx, "tl", doc.jgId, id);
      for (const l of lines) returned.set(l.skuId, dAdd(returned.get(l.skuId) ?? "0", l.qty));
      for (const [skuId, qty] of returned) {
        if (dCmp(qty, issued.get(skuId) ?? "0") > 0) {
          throw new ApiError(409, `退料超过累计发料: sku#${skuId}（累计退 ${qty} > 累计发 ${issued.get(skuId) ?? "0"}）`);
        }
      }

      // 过账 tl_return：委外仓 −（sourceLineId=行id）/ 自有仓 +（sourceLineId=−行id）
      await post(tx, {
        sourceDocType: "tl_return",
        sourceDocId: id,
        action: "post",
        lines: lines.flatMap((l) => [
          { sourceLineId: l.id, skuId: l.skuId, warehouseId: doc.fromWarehouseId, batchId: l.batchId, qtyDelta: dNeg(l.qty) },
          { sourceLineId: -l.id, skuId: l.skuId, warehouseId: doc.toWarehouseId, batchId: l.batchId, qtyDelta: dQty(l.qty) },
        ]),
      });

      const finalStatus = await completeApprovedDoc(tx, tlDocs, id);
      await writeAudit(tx, {
        userId: user.id, entity: "tl", entityId: id, action: "post_and_complete",
        after: { via: "approve" },
      });
      return { status: finalStatus, idempotent: false };
    });
  } catch (e) {
    if (e instanceof PostingError && e.code === "NEGATIVE_STOCK") {
      throw new ApiError(409, `库存不足：${e.message}`);
    }
    rethrowApproval(e);
  }
}

/** 该 JG 已生效 FL/TL 单的逐物料累计量（excludeId=排除审批中的本单） */
async function sumByskuOf(
  db: AnyDb,
  kind: "fl" | "tl",
  jgId: number,
  excludeId?: number,
): Promise<Map<number, string>> {
  const [docsT, linesT, fk] =
    kind === "fl" ? ([flDocs, flLines, flLines.flId] as const) : ([tlDocs, tlLines, tlLines.tlId] as const);
  const conds = [eq(docsT.jgId, jgId), inArray(docsT.status, [...ACTIVE_DOC_STATUSES])];
  if (excludeId != null) conds.push(ne(docsT.id, excludeId));
  const rows: { skuId: number; qty: string }[] = await db
    .select({ skuId: linesT.skuId, qty: linesT.qty })
    .from(linesT)
    .innerJoin(docsT, eq(fk, docsT.id))
    .where(and(...conds));
  const m = new Map<number, string>();
  for (const r of rows) m.set(r.skuId, dAdd(m.get(r.skuId) ?? "0", r.qty));
  return m;
}

// ---------- 查询 ----------

export async function getTl(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const fromWh = alias(warehouses, "wh_from");
  const toWh = alias(warehouses, "wh_to");
  const [doc] = await db
    .select({
      id: tlDocs.id,
      docNo: tlDocs.docNo,
      status: tlDocs.status,
      remark: tlDocs.remark,
      version: tlDocs.version,
      jgId: tlDocs.jgId,
      jgDocNo: jgDocs.docNo,
      fromWarehouseId: tlDocs.fromWarehouseId,
      fromWarehouseName: fromWh.name,
      toWarehouseId: tlDocs.toWarehouseId,
      toWarehouseName: toWh.name,
      createdBy: tlDocs.createdBy,
      createdAt: tlDocs.createdAt,
      createdByName: users.name,
    })
    .from(tlDocs)
    .innerJoin(jgDocs, eq(tlDocs.jgId, jgDocs.id))
    .innerJoin(fromWh, eq(tlDocs.fromWarehouseId, fromWh.id))
    .innerJoin(toWh, eq(tlDocs.toWarehouseId, toWh.id))
    .leftJoin(users, eq(tlDocs.createdBy, users.id))
    .where(eq(tlDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines = await db
    .select({
      id: tlLines.id,
      skuId: tlLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      qty: tlLines.qty,
      batchId: tlLines.batchId,
      reason: tlLines.reason,
    })
    .from(tlLines)
    .innerJoin(skus, eq(tlLines.skuId, skus.id))
    .where(eq(tlLines.tlId, id))
    .orderBy(tlLines.id);

  const approvalRows = await loadApprovalHistory(db, "tl", id);

  return { ...doc, lines, approvals: approvalRows };
}

export async function listTls(
  q: string,
  opts: { status?: string; jgId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(sql`${tlDocs.docNo} ILIKE ${"%" + q + "%"}`);
  if (opts.status) conds.push(eq(tlDocs.status, opts.status as DocStatus));
  if (opts.jgId) conds.push(eq(tlDocs.jgId, opts.jgId));
  const where = conds.length ? and(...conds) : undefined;

  const fromWh = alias(warehouses, "wh_from");
  const toWh = alias(warehouses, "wh_to");
  const lineAgg = db
    .select({ tlId: tlLines.tlId, lineCount: sql<number>`count(*)::int`.as("agg_line_count") })
    .from(tlLines)
    .groupBy(tlLines.tlId)
    .as("la");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: tlDocs.id,
        docNo: tlDocs.docNo,
        status: tlDocs.status,
        jgId: tlDocs.jgId,
        jgDocNo: jgDocs.docNo,
        fromWarehouseName: fromWh.name,
        toWarehouseName: toWh.name,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        createdByName: users.name,
        createdAt: tlDocs.createdAt,
      })
      .from(tlDocs)
      .innerJoin(jgDocs, eq(tlDocs.jgId, jgDocs.id))
      .innerJoin(fromWh, eq(tlDocs.fromWarehouseId, fromWh.id))
      .innerJoin(toWh, eq(tlDocs.toWarehouseId, toWh.id))
      .leftJoin(lineAgg, eq(lineAgg.tlId, tlDocs.id))
      .leftJoin(users, eq(tlDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(tlDocs.createdAt), desc(tlDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(tlDocs).where(where),
  ]);
  return { rows, total };
}
