import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
   approvalConfigs, batches, ctDocs, ctLines, poDocs, poLines, skus, stockLedger, users, warehouses,
} from "@/db/schema";
import { dAdd, dCmp, dNeg, dQty, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approveDoc, loadApprovalHistory } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, type DocStatus } from "@/server/docflow/state";
import { post, PostingError } from "@/server/posting";
import { ApiError } from "@/server/modules/master/common";
import {
  type AnyDb, requireAnyRole, resolveDb, rethrowApproval,
} from "@/server/modules/outsource/common";
import { approveDocSchema } from "@/server/modules/outsource/schemas";
import { completeApprovedDoc, lockMatflowWarehouses, requireRealtimeWarehouse } from "./common-notes";
import { createCtSchema, updateCtSchema, voidCtSchema } from "./schemas";
import { canEditMaterialDraft, materialTaskActions } from "./task-actions";
import { outboundBatchBlock } from "@/server/posting/batch-eligibility";
import { requirePurchaseReturnStatus, resolveReturnPhysicalLines } from "./return-lots";
import { skuLineMatch } from "@/server/core/doc-search";
import { lockPurchaseReceipt } from "./purchase-receipt-lock";
import { currentWriteActor as currentMatflowActor } from "@/server/core/current-write-actor";

/**
 * 采购退货单 CT（B9）：仓库 −，PO 已收数回冲（po_line.receivedQty −=，基础单位）。
 * 逐行守卫：退货量 ≤ 该 PO 行当前 receivedQty（创建校验 + 审批时点兜底重查）。
 * 过账 ct_return，审批即瞬时执行完成。
 */

type CtRow = typeof ctDocs.$inferSelect;
type CtLineRow = typeof ctLines.$inferSelect;
type PoLineRow = typeof poLines.$inferSelect;

async function hasCtPosting(db: AnyDb, id: number): Promise<boolean> {
  const [row] = await db.select({ id: stockLedger.id }).from(stockLedger)
    .where(and(eq(stockLedger.sourceDocType, "ct_return"), eq(stockLedger.sourceDocId, id))).limit(1);
  return Boolean(row);
}
function replacementBlocked(status: string, posted: boolean, successor: boolean): string | null {
  if (status !== "void") return "仅已作废且未过账的采购退货单可新建替代单";
  if (posted) return "原单存在退货库存流水，不能用替代草稿代替库存及采购已收数纠错；请联系仓管核对";
  if (successor) return "已存在后续替代单，请查看该单；若它也有误，应从它作废后继续替代";
  return null;
}

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

  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentMatflowActor(tx, user);
  requireAnyRole(actor, "warehouse");
  if (v.replacementOfId != null) {
    const [original]: CtRow[] = await tx.select().from(ctDocs).where(eq(ctDocs.id, v.replacementOfId)).for("update");
    if (!original) throw new ApiError(404, "被替代采购退货原单不存在，请核对原单编号");
    if (original.createdBy !== actor.id && !actor.roles.includes("admin")) throw new ApiError(403, "仅原制单仓管或管理员可新建替代单");
    const [successor] = await tx.select({ id: ctDocs.id }).from(ctDocs).where(eq(ctDocs.replacementOfId, original.id)).limit(1);
    const blocked = replacementBlocked(original.status, await hasCtPosting(tx, original.id), Boolean(successor));
    if (blocked) throw new ApiError(409, blocked);
  }
  const { po, lines: plRows } = await lockPurchaseReceipt(tx, v.poId);
  requirePurchaseReturnStatus(po.status);
  await lockMatflowWarehouses(tx, [v.warehouseId]);
  await requireRealtimeWarehouse(tx, v.warehouseId, "退货出库仓");
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

    const allocatedLines = await resolveReturnPhysicalLines(tx, v.warehouseId, v.lines);
    const docNo = await nextDocNo(tx, "CT");
    const [doc]: CtRow[] = await tx
      .insert(ctDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        poId: v.poId,
        warehouseId: v.warehouseId,
        createdBy: actor.id,
        replacementOfId: v.replacementOfId ?? null,
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
      userId: actor.id, entity: "ct", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, poId: v.poId, lineCount: allocatedLines.length,
        ...(doc.replacementOfId == null ? {} : { replacementOfId: doc.replacementOfId }) },
    });
    return doc;
  });
}

// ---------- 原草稿纠正：不换来源、仓、物料或实物批次 ----------

export async function updateCt(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<CtRow> {
  const v = updateCtSchema.parse(input), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentMatflowActor(tx, user);
    requireAnyRole(actor, "warehouse");
    const [doc]: CtRow[] = await tx.select().from(ctDocs).where(eq(ctDocs.id, id)).for("update");
    if (!doc) throw new ApiError(404, "采购退货单不存在");
    if (doc.status !== "draft") throw new ApiError(409, "仅草稿或已驳回的退货单可修改；待审批先驳回，已生效单据不可改写");
    if (!canEditMaterialDraft(actor, doc)) throw new ApiError(403, "仅当前具备仓管权限的制单人或管理员可修改原草稿");
    if (doc.version !== v.version) throw new ApiError(409, "单据版本已变化，请重新读取核对，未覆盖他人的修改");
    const [posted] = await tx.select({ id: stockLedger.id }).from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "ct_return"), eq(stockLedger.sourceDocId, id))).limit(1);
    if (posted) throw new ApiError(409, "原单已有库存流水，不可按草稿改写；请联系仓管核对纠错");
    const { po, lines: sourceLines } = await lockPurchaseReceipt(tx, doc.poId);
    requirePurchaseReturnStatus(po.status);
    await lockMatflowWarehouses(tx, [doc.warehouseId]);
    await requireRealtimeWarehouse(tx, doc.warehouseId, "原退货出库仓");
    const beforeLines: CtLineRow[] = await tx.select().from(ctLines).where(eq(ctLines.ctId, id)).orderBy(ctLines.id);
    const byId = new Map(beforeLines.map(line => [line.id, line]));
    const sourceById = new Map(sourceLines.map(line => [line.id, line]));
    const totals = new Map<number, string>();
    const afterLines = v.lines.map(line => {
      const original = byId.get(line.id);
      if (!original) throw new ApiError(409, "退货行不属于当前原单，请重新读取；不可借用其他单据行");
      const source = sourceById.get(original.poLineId);
      if (!source || source.skuId !== original.skuId) throw new ApiError(409, "原退货行与采购来源不匹配，请核对原采购行身份");
      totals.set(source.id, dAdd(totals.get(source.id) ?? "0", line.qty));
      return { ...original, qty: dQty(line.qty), reason: line.reason ?? null };
    });
    assertWithinReceived(totals, sourceById);
    const block = await outboundBatchBlock(tx, { sourceDocType: "ct_return", sourceDocId: id, action: "post",
      lines: afterLines.map(line => ({ sourceLineId: line.id, skuId: line.skuId, warehouseId: doc.warehouseId, batchId: line.batchId, qtyDelta: dNeg(line.qty) })) });
    if (block) throw new PostingError(block.code, block.message);
    await resolveReturnPhysicalLines(tx, doc.warehouseId, afterLines);
    const [saved]: CtRow[] = await tx.update(ctDocs).set({ remark: v.remark ?? null,
      version: sql`${ctDocs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(ctDocs.id, id), eq(ctDocs.status, "draft"), eq(ctDocs.version, v.version))).returning();
    if (!saved) throw new ApiError(409, "版本冲突，请重新读取核对");
    const retained = new Set(afterLines.map(line => line.id)), removed = beforeLines.filter(line => !retained.has(line.id)).map(line => line.id);
    if (removed.length) await tx.delete(ctLines).where(and(eq(ctLines.ctId, id), inArray(ctLines.id, removed)));
    for (const line of afterLines) await tx.update(ctLines).set({ qty: line.qty, reason: line.reason })
      .where(and(eq(ctLines.ctId, id), eq(ctLines.id, line.id)));
    await writeAudit(tx, { userId: actor.id, entity: "ct", entityId: id, action: "update_draft",
      before: { version: doc.version, remark: doc.remark, lines: beforeLines },
      after: { version: saved.version, remark: saved.remark, lines: afterLines } });
    return saved;
  });
}

// Never-effective drafts can be abandoned without rewriting their source or physical lines.
export async function voidCt(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<CtRow> {
  const v = voidCtSchema.parse(input), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentMatflowActor(tx, user);
    requireAnyRole(actor, "warehouse");
    const [doc]: CtRow[] = await tx.select().from(ctDocs).where(eq(ctDocs.id, id)).for("update");
    if (!doc) throw new ApiError(404, "采购退货单不存在");
    if (doc.status !== "draft") throw new ApiError(409, "仅未生效草稿可作废；待审批请先由合格审批人驳回，已生效单据不能作废");
    if (!canEditMaterialDraft(actor, doc)) throw new ApiError(403, "仅当前具备仓管权限的制单人或管理员可作废原草稿");
    if (doc.version !== v.version) throw new ApiError(409, "单据版本已变化，请重新读取核对后再决定是否作废");
    const [posted] = await tx.select({ id: stockLedger.id }).from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "ct_return"), eq(stockLedger.sourceDocId, id))).limit(1);
    if (posted) throw new ApiError(409, "原单已有库存流水，不能作废或隐藏历史；请核对红字纠错流程");
    // A closed PO, disabled warehouse or invalid lot must not trap a never-posted draft.
    const [saved]: CtRow[] = await tx.update(ctDocs).set({ status: nextStatus(doc.status, "void"),
      closedReason: v.reason, version: sql`${ctDocs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(ctDocs.id, id), eq(ctDocs.status, "draft"), eq(ctDocs.version, v.version))).returning();
    if (!saved) throw new ApiError(409, "版本冲突，请重新读取原单核对");
    await writeAudit(tx, { userId: actor.id, entity: "ct", entityId: id, action: "void",
      before: { status: doc.status, version: doc.version, closedReason: doc.closedReason },
      after: { status: saved.status, version: saved.version, reason: v.reason, poId: doc.poId, warehouseId: doc.warehouseId } });
    return saved;
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
    const { po } = await lockPurchaseReceipt(tx, doc.poId);
    requirePurchaseReturnStatus(po.status);
    await lockMatflowWarehouses(tx, [doc.warehouseId]);
    await requireRealtimeWarehouse(tx, doc.warehouseId, "退货出库仓");
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
      const { po, lines: plRows } = await lockPurchaseReceipt(tx, doc.poId);
      requirePurchaseReturnStatus(po.status);
      await lockMatflowWarehouses(tx, [doc.warehouseId]);
      await requireRealtimeWarehouse(tx, doc.warehouseId, "退货出库仓");
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

export async function getCt(id: number, dbArg?: AnyDb, user?: SessionUser) {
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: ctDocs.id,
      docNo: ctDocs.docNo,
      status: ctDocs.status,
      remark: ctDocs.remark,
      closedReason: ctDocs.closedReason,
      replacementOfId: ctDocs.replacementOfId,
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
    .leftJoin(batches, and(eq(ctLines.batchId, batches.id), eq(ctLines.skuId, batches.skuId)))
    .where(eq(ctLines.ctId, id))
    .orderBy(ctLines.id);

  const approvalRows = await loadApprovalHistory(db, "ct", id);

  let actions;
  if (user) {
    const [cfg] = await db.select({ role: approvalConfigs.approverRole }).from(approvalConfigs).where(eq(approvalConfigs.docType, "ct"));
    let sourceBlock: string | null = null, quantityBlock: string | null = null;
    try {
      const [po] = await db.select({ status: poDocs.status }).from(poDocs).where(eq(poDocs.id, doc.poId));
      if (!po) throw new ApiError(409, "来源采购订单不存在，请核对");
      requirePurchaseReturnStatus(po.status);
      await requireRealtimeWarehouse(db, doc.warehouseId, "原退货出库仓");
    } catch (e) { if (e instanceof ApiError && e.status < 500) sourceBlock = e.message; else throw e; }
    const sourceLines = await db.select().from(poLines).where(eq(poLines.poId, doc.poId));
    const sourceById = new Map(sourceLines.map(line => [line.id, line]));
    const totals = new Map<number, string>();
    for (const line of lines) {
      if (sourceById.get(line.poLineId)?.skuId !== line.skuId) quantityBlock = "退货行与原采购行身份不一致，请核对";
      totals.set(line.poLineId, dAdd(totals.get(line.poLineId) ?? "0", line.qty));
    }
    if (!lines.length) quantityBlock = "采购退货单无明细，请核对";
    if (!quantityBlock) try { assertWithinReceived(totals, sourceById); }
    catch (e) { if (e instanceof ApiError && e.status < 500) quantityBlock = e.message; else throw e; }
    const [posted] = await db.select({ id: stockLedger.id }).from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "ct_return"), eq(stockLedger.sourceDocId, id))).limit(1);
    actions = { ...materialTaskActions(user, doc, cfg?.role ?? null, sourceBlock, quantityBlock),
      edit: canEditMaterialDraft(user, doc) && !sourceBlock && !posted,
      void: canEditMaterialDraft(user, doc) && !posted };
  }
  const relationColumns = { id: ctDocs.id, docNo: ctDocs.docNo, status: ctDocs.status };
  const [[predecessor], [successor]] = await Promise.all([
    doc.replacementOfId == null ? Promise.resolve([]) : db.select(relationColumns).from(ctDocs).where(eq(ctDocs.id, doc.replacementOfId)),
    db.select(relationColumns).from(ctDocs).where(eq(ctDocs.replacementOfId, doc.id)).limit(1),
  ]);
  const replacementReason = replacementBlocked(doc.status, doc.status === "void" && await hasCtPosting(db, doc.id), Boolean(successor));
  const replacementAllowed = Boolean(user && (user.roles.includes("admin") || (user.roles.includes("warehouse") && doc.createdBy === user.id)) && !replacementReason);
  return { ...doc, lines, approvals: approvalRows, actions,
    replacement: { predecessor: predecessor ?? null, successor: successor ?? null, canCreate: replacementAllowed,
      reason: replacementReason ?? (replacementAllowed ? null : "请由原制单仓管或管理员新建替代单") } };
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
