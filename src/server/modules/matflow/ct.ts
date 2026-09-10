import { and, desc, eq, or, sql } from "drizzle-orm";
import {
   batches, ctDocs, ctLines, poDocs, poLines, skus, users, warehouses,
} from "@/db/schema";
import { dAdd, dCmp, dNeg, dQty, dSub } from "@/server/core/decimal";
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
import { completeApprovedDoc, requireRealtimeWarehouse } from "./common-notes";
import { createCtSchema } from "./schemas";
import { expandOutboundLinesForBatchPosting } from "@/server/modules/inventory/batch-allocation";
import { skuLineMatch } from "@/server/core/doc-search";
import { lockPurchaseReceipt } from "./purchase-receipt-lock";
import { currentMatflowActor } from "./current-actor";

/**
 * 采购退货单 CT（B9）：仓库 −，PO 已收数回冲（po_line.receivedQty −=，基础单位）。
 * 逐行守卫：退货量 ≤ 该 PO 行当前 receivedQty（创建校验 + 审批时点兜底重查）。
 * 过账 ct_return，审批即瞬时执行完成。
 */

type CtRow = typeof ctDocs.$inferSelect;
type CtLineRow = typeof ctLines.$inferSelect;
type PoLineRow = typeof poLines.$inferSelect;

/** 逐 PO 行合计本单退货量，并校验 ≤ 当前已收数 */
function assertWithinReceived(
  ctQtyByPoLine: Map<number, string>,
  poLineById: Map<number, PoLineRow>,
): void {
  for (const [poLineId, qty] of ctQtyByPoLine) {
    const pl = poLineById.get(poLineId);
    if (!pl) throw new ApiError(400, `PO 行不存在或不属于该 PO: po_line#${poLineId}`);
    if (dCmp(qty, pl.receivedQty) > 0) {
      throw new ApiError(409, `退货量超过已收数: po_line#${poLineId}（退 ${qty} > 已收 ${pl.receivedQty}）`);
    }
  }
}

// ---------- 创建 ----------

export async function createCt(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<CtRow> {
  requireAnyRole(user, "warehouse");
  const v = createCtSchema.parse(input);
  const db = await resolveDb(dbArg);

  const [po]: (typeof poDocs.$inferSelect)[] = await db.select().from(poDocs).where(eq(poDocs.id, v.poId));
  if (!po) throw new ApiError(404, `采购订单不存在: #${v.poId}`);
  await requireRealtimeWarehouse(db, v.warehouseId, "退货出库仓");

  const plRows: PoLineRow[] = await db.select().from(poLines).where(eq(poLines.poId, v.poId));
  const poLineById = new Map(plRows.map((r) => [r.id, r]));
  const ctQtyByPoLine = new Map<number, string>();
  for (const l of v.lines) {
    const pl = poLineById.get(l.poLineId);
    if (!pl) throw new ApiError(400, `PO 行不存在或不属于该 PO: po_line#${l.poLineId}`);
    if (pl.skuId !== l.skuId) {
      throw new ApiError(400, `退货行 SKU 与 PO 行不符: po_line#${l.poLineId} 是 sku#${pl.skuId}，实传 sku#${l.skuId}`);
    }
    ctQtyByPoLine.set(l.poLineId, dAdd(ctQtyByPoLine.get(l.poLineId) ?? "0", l.qty));
  }
  assertWithinReceived(ctQtyByPoLine, poLineById);

  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentMatflowActor(tx, user);
    requireAnyRole(actor, "warehouse");
    const allocatedLines = await expandOutboundLinesForBatchPosting(tx, v.warehouseId, v.lines);
    const docNo = await nextDocNo(tx, "CT");
    const [doc]: CtRow[] = await tx
      .insert(ctDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        poId: v.poId,
        warehouseId: v.warehouseId,
        createdBy: user.id,
      })
      .returning();
    await tx.insert(ctLines).values(
      allocatedLines.map((l) => ({
        ctId: doc.id,
        poLineId: l.poLineId,
        skuId: l.skuId,
        qty: dQty(l.qty),
        batchId: l.batchId,
        reason: l.reason ?? null,
      })),
    );
    await writeAudit(tx, {
      userId: user.id, entity: "ct", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, poId: v.poId, lineCount: allocatedLines.length },
    });
    return doc;
  });
}

// ---------- 提交 ----------

export async function submitCt(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<CtRow> {
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentMatflowActor(tx, user);
    const [doc]: CtRow[] = await tx.select().from(ctDocs).where(eq(ctDocs.id, id)).for("update");
    if (!doc) throw new ApiError(404, "单据不存在");
    if (doc.createdBy !== actor.id && !actor.roles.includes("warehouse") && !actor.roles.includes("admin")) {
      throw new ApiError(403, "仅制单人/仓管/管理员可提交");
    }
    if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
    const updated: CtRow[] = await tx
      .update(ctDocs)
      .set({ status: "pending", version: sql`${ctDocs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(ctDocs.id, id), eq(ctDocs.version, version)))
      .returning();
    if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
    await writeAudit(tx, { userId: actor.id, entity: "ct", entityId: id, action: "submit" });
    return updated[0];
  });
}

// ---------- 审批（过账 ct_return + 已收数回冲，同一事务） ----------

export async function approveCt(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const actor = await currentMatflowActor(tx, user);
      const [doc]: CtRow[] = await tx.select().from(ctDocs).where(eq(ctDocs.id, id)).for("update");
      if (!doc) throw new ApiError(404, "单据不存在");

      const r = await approveDoc(tx, {
        docType: "ct",
        table: ctDocs,
        docId: id,
        approver: actor,
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "ct", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      if (v.action === "reject") return r;

      const lines: CtLineRow[] = await tx.select().from(ctLines).where(eq(ctLines.ctId, id)).orderBy(ctLines.id);
      if (lines.length === 0) throw new ApiError(409, "退货单无行，不可审批过账");

      // 兜底重查：创建后可能又有 CT 回冲过——退货量不得超过当前已收数
      const { lines: plRows } = await lockPurchaseReceipt(tx, doc.poId);
      const poLineById = new Map(plRows.map((row) => [row.id, row]));
      const ctQtyByPoLine = new Map<number, string>();
      for (const l of lines) {
        const pl = poLineById.get(l.poLineId);
        if (!pl || pl.skuId !== l.skuId) throw new ApiError(409, `退货行与来源采购订单不匹配: po_line#${l.poLineId}`);
        ctQtyByPoLine.set(l.poLineId, dAdd(ctQtyByPoLine.get(l.poLineId) ?? "0", l.qty));
      }
      assertWithinReceived(ctQtyByPoLine, poLineById);

      // 过账 ct_return：仓库 −
      await post(tx, {
        sourceDocType: "ct_return",
        sourceDocId: id,
        action: "post",
        lines: lines.map((l) => ({
          sourceLineId: l.id, skuId: l.skuId, warehouseId: doc.warehouseId, batchId: l.batchId, qtyDelta: dNeg(l.qty),
        })),
      });

      // PO 已收数回冲（基础单位）
      for (const [poLineId, qty] of ctQtyByPoLine) {
        const pl = poLineById.get(poLineId)!;
        await tx
          .update(poLines)
          .set({ receivedQty: dSub(pl.receivedQty, qty) })
          .where(eq(poLines.id, poLineId));
      }

      const finalStatus = await completeApprovedDoc(tx, ctDocs, id);
      await writeAudit(tx, {
        userId: user.id, entity: "ct", entityId: id, action: "post_and_complete",
        after: { via: "approve", poId: doc.poId },
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

// ---------- 查询 ----------

export async function getCt(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: ctDocs.id,
      docNo: ctDocs.docNo,
      status: ctDocs.status,
      remark: ctDocs.remark,
      version: ctDocs.version,
      poId: ctDocs.poId,
      poDocNo: poDocs.docNo,
      warehouseId: ctDocs.warehouseId,
      warehouseName: warehouses.name,
      createdBy: ctDocs.createdBy,
      createdAt: ctDocs.createdAt,
      createdByName: users.name,
    })
    .from(ctDocs)
    .innerJoin(poDocs, eq(ctDocs.poId, poDocs.id))
    .innerJoin(warehouses, eq(ctDocs.warehouseId, warehouses.id))
    .leftJoin(users, eq(ctDocs.createdBy, users.id))
    .where(eq(ctDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines = await db
    .select({
      id: ctLines.id,
      poLineId: ctLines.poLineId,
      skuId: ctLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      qty: ctLines.qty,
      batchId: ctLines.batchId,
      batchNo: batches.batchNo,
      expiryDate: batches.expiryDate,
      reason: ctLines.reason,
    })
    .from(ctLines)
    .innerJoin(skus, eq(ctLines.skuId, skus.id))
    .leftJoin(batches, eq(ctLines.batchId, batches.id))
    .where(eq(ctLines.ctId, id))
    .orderBy(ctLines.id);

  const approvalRows = await loadApprovalHistory(db, "ct", id);

  return { ...doc, lines, approvals: approvalRows };
}

export async function listCts(
  q: string,
  opts: { status?: string; poId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(or(sql`${ctDocs.docNo} ILIKE ${"%" + q + "%"}`, skuLineMatch("ct_lines", "ct_id", ctDocs.id, q)));
  if (opts.status) conds.push(eq(ctDocs.status, opts.status as DocStatus));
  if (opts.poId) conds.push(eq(ctDocs.poId, opts.poId));
  const where = conds.length ? and(...conds) : undefined;

  const lineAgg = db
    .select({ ctId: ctLines.ctId, lineCount: sql<number>`count(*)::int`.as("agg_line_count") })
    .from(ctLines)
    .groupBy(ctLines.ctId)
    .as("la");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: ctDocs.id,
        docNo: ctDocs.docNo,
        status: ctDocs.status,
        poId: ctDocs.poId,
        poDocNo: poDocs.docNo,
        warehouseName: warehouses.name,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        createdByName: users.name,
        createdAt: ctDocs.createdAt,
      })
      .from(ctDocs)
      .innerJoin(poDocs, eq(ctDocs.poId, poDocs.id))
      .innerJoin(warehouses, eq(ctDocs.warehouseId, warehouses.id))
      .leftJoin(lineAgg, eq(lineAgg.ctId, ctDocs.id))
      .leftJoin(users, eq(ctDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(ctDocs.createdAt), desc(ctDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(ctDocs).where(where),
  ]);
  return { rows, total };
}
