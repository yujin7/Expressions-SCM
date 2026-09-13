import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
   approvalConfigs, batches, flDocs, flLines, jgDocs, skus, stockLedger, tlDocs, tlLines, users, warehouses,
} from "@/db/schema";
import { dAdd, dNeg, dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { currentWriteActor } from "@/server/core/current-write-actor";
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
  requireRealtimeWarehouse, lockMatflowJg, lockMatflowWarehouses, matflowSourceBlock,
} from "./common-notes";
import { createTlSchema, updateTlSchema } from "./schemas";
import { outboundBatchBlock } from "@/server/posting/batch-eligibility";
import { resolveReturnPhysicalLines } from "./return-lots";
import { skuLineMatch } from "@/server/core/doc-search";
import { canEditMaterialDraft, materialExcess, materialTaskActions } from "./task-actions";

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
  const v = createTlSchema.parse(input);
  const db = await resolveDb(dbArg);

  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user); requireAnyRole(actor, "warehouse");
  await lockMatflowJg(tx, v.jgId);
  const jg = await getJgForMatflow(tx, v.jgId, "return");
  const fromWh = await getOutsourceWarehouseOf(tx, jg.supplierId, v.fromWarehouseId);
  await lockMatflowWarehouses(tx, [fromWh.id, v.toWarehouseId]);
  await getOutsourceWarehouseOf(tx, jg.supplierId, fromWh.id);
  await requireRealtimeWarehouse(tx, v.toWarehouseId, "退回仓");

  const skuIds = [...new Set(v.lines.map((l) => l.skuId))];
  const skuRows: { id: number; active: boolean }[] = await tx
    .select({ id: skus.id, active: skus.active })
    .from(skus)
    .where(inArray(skus.id, skuIds));
  const activeSku = new Set(skuRows.filter((s) => s.active).map((s) => s.id));
  for (const sid of skuIds) {
    if (!activeSku.has(sid)) throw new ApiError(400, `SKU 不存在或已停用: #${sid}`);
  }

    const allocatedLines = await resolveReturnPhysicalLines(tx, fromWh.id, v.lines);
    const docNo = await nextDocNo(tx, "TL");
    const [doc]: TlRow[] = await tx
      .insert(tlDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        jgId: jg.id,
        fromWarehouseId: fromWh.id,
        toWarehouseId: v.toWarehouseId,
        createdBy: actor.id,
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
      userId: actor.id, entity: "tl", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, jgId: jg.id, fromWarehouseId: fromWh.id, lineCount: allocatedLines.length },
    });
    return doc;
  });
}

// ---------- 原单纠正：物料/批次/来源不变，不配批、不提交、不过账 ----------

export async function updateTl(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<TlRow> {
  const v = updateTlSchema.parse(input), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "warehouse");
    const [source]: TlRow[] = await tx.select().from(tlDocs).where(eq(tlDocs.id, id));
    if (!source) throw new ApiError(404, "退料单不存在");
    await lockMatflowJg(tx, source.jgId);
    const [doc]: TlRow[] = await tx.select().from(tlDocs).where(eq(tlDocs.id, id)).for("update");
    if (!doc || doc.jgId !== source.jgId) throw new ApiError(409, "退料来源已变化，请重新读取核对");
    if (doc.status !== "draft") throw new ApiError(409, "仅草稿或已驳回的退料单可修改；待审批先驳回，已生效单据不可改写");
    if (!canEditMaterialDraft(actor, doc)) throw new ApiError(403, "仅当前具备仓管权限的制单人或管理员可修改退料草稿");
    if (doc.version !== v.version) throw new ApiError(409, "单据版本已变化，请重新读取核对，未覆盖他人的修改");
    const [posted] = await tx.select({ id: stockLedger.id }).from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "tl_return"), eq(stockLedger.sourceDocId, id))).limit(1);
    if (posted) throw new ApiError(409, "原单已有库存流水，不可按草稿改写；请联系仓管核对纠错");
    const jg = await getJgForMatflow(tx, doc.jgId, "return");
    await lockMatflowWarehouses(tx, [doc.fromWarehouseId, doc.toWarehouseId, v.toWarehouseId]);
    await getOutsourceWarehouseOf(tx, jg.supplierId, doc.fromWarehouseId);
    await requireRealtimeWarehouse(tx, v.toWarehouseId, "退回仓");
    const beforeLines: TlLineRow[] = await tx.select().from(tlLines).where(eq(tlLines.tlId, id)).orderBy(tlLines.id);
    const byId = new Map(beforeLines.map(line => [line.id, line]));
    const afterLines = v.lines.map(line => {
      const original = byId.get(line.id);
      if (!original) throw new ApiError(409, "退料行不属于当前原单，请重新读取；不可借用其他单据的物料或批次");
      return { ...original, qty: dQty(line.qty), reason: line.reason };
    });
    const block = await outboundBatchBlock(tx, { sourceDocType: "tl_return", sourceDocId: id, action: "post",
      lines: afterLines.map(line => ({ sourceLineId: line.id, skuId: line.skuId, warehouseId: doc.fromWarehouseId, batchId: line.batchId, qtyDelta: dNeg(line.qty) })) });
    if (block) throw new PostingError(block.code, block.message);
    const [saved]: TlRow[] = await tx.update(tlDocs).set({ toWarehouseId: v.toWarehouseId, remark: v.remark ?? null,
      version: sql`${tlDocs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(tlDocs.id, id), eq(tlDocs.status, "draft"), eq(tlDocs.version, v.version))).returning();
    if (!saved) throw new ApiError(409, "版本冲突，请重新读取核对");
    const retained = new Set(afterLines.map(line => line.id));
    const removed = beforeLines.filter(line => !retained.has(line.id)).map(line => line.id);
    if (removed.length) await tx.delete(tlLines).where(and(eq(tlLines.tlId, id), inArray(tlLines.id, removed)));
    for (const line of afterLines) await tx.update(tlLines).set({ qty: line.qty, reason: line.reason })
      .where(and(eq(tlLines.tlId, id), eq(tlLines.id, line.id)));
    await writeAudit(tx, { userId: actor.id, entity: "tl", entityId: id, action: "update_draft",
      before: { version: doc.version, toWarehouseId: doc.toWarehouseId, remark: doc.remark, lines: beforeLines },
      after: { version: saved.version, toWarehouseId: saved.toWarehouseId, remark: saved.remark, lines: afterLines } });
    return saved;
  });
}

// ---------- 提交 ----------

export async function submitTl(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<TlRow> {
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user);
  const [doc]: TlRow[] = await tx.select().from(tlDocs).where(eq(tlDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  await lockMatflowJg(tx, doc.jgId);
  await getJgForMatflow(tx, doc.jgId, "return");
  if (doc.createdBy !== actor.id && !actor.roles.includes("warehouse") && !actor.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/仓管/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  const updated: TlRow[] = await tx
    .update(tlDocs)
    .set({ status: "pending", version: sql`${tlDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(tlDocs.id, id), eq(tlDocs.version, version), eq(tlDocs.status, "draft")))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(tx, { userId: actor.id, entity: "tl", entityId: id, action: "submit" });
  return updated[0];
  });
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
      const actor = await currentWriteActor(tx, user);
      const [doc]: TlRow[] = await tx.select().from(tlDocs).where(eq(tlDocs.id, id));
      if (!doc) throw new ApiError(404, "单据不存在");
      await lockMatflowJg(tx, doc.jgId);

      const r = await approveDoc(tx, {
        docType: "tl",
        table: tlDocs,
        docId: id,
        approver: actor,
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: actor.id, entity: "tl", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      if (v.action === "reject") return r;
      const sourceJg = await getJgForMatflow(tx, doc.jgId, "return");
      await lockMatflowWarehouses(tx, [doc.fromWarehouseId, doc.toWarehouseId]);
      await getOutsourceWarehouseOf(tx, sourceJg.supplierId, doc.fromWarehouseId);
      await requireRealtimeWarehouse(tx, doc.toWarehouseId, "退回仓");

      const lines: TlLineRow[] = await tx.select().from(tlLines).where(eq(tlLines.tlId, id)).orderBy(tlLines.id);
      if (lines.length === 0) throw new ApiError(409, "退料单无行，不可审批过账");

      // MVP 守卫：逐物料 累计TL（他单已生效+本单） ≤ 累计FL（已生效）
      const issued = await sumByskuOf(tx, "fl", doc.jgId);
      const returned = await sumByskuOf(tx, "tl", doc.jgId, id);
      const excess = materialExcess(lines, returned, issued);
      if (excess) throw new ApiError(409, `退料超过累计发料: sku#${excess.skuId}（累计退 ${excess.qty} > 累计发 ${excess.limit}）`);

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
        userId: actor.id, entity: "tl", entityId: id, action: "post_and_complete",
        after: { via: "approve", settlementEffect: "physical_return_only_no_frozen_settlement_rewrite" },
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

export async function getTl(id: number, dbArg?: AnyDb, user?: SessionUser) {
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
      batchNo: batches.batchNo,
      expiryDate: batches.expiryDate,
      reason: tlLines.reason,
    })
    .from(tlLines)
    .innerJoin(skus, eq(tlLines.skuId, skus.id))
    .leftJoin(batches, and(eq(tlLines.batchId, batches.id), eq(tlLines.skuId, batches.skuId)))
    .where(eq(tlLines.tlId, id))
    .orderBy(tlLines.id);

  const approvalRows = await loadApprovalHistory(db, "tl", id);

  let actions;
  if (user) {
    const [cfg] = await db.select({ role: approvalConfigs.approverRole }).from(approvalConfigs).where(eq(approvalConfigs.docType, "tl"));
    const sourceBlock = await matflowSourceBlock(db, doc.jgId, "return");
    const [issued, returned] = await Promise.all([sumByskuOf(db, "fl", doc.jgId), sumByskuOf(db, "tl", doc.jgId, id)]);
    const excess = materialExcess(lines, returned, issued);
    const quantityBlock = !lines.length ? "退料单无明细，请核对单据。"
      : excess ? `退料超过累计发料：sku#${excess.skuId}（累计退 ${excess.qty} > 累计发 ${excess.limit}），请核对所属工单。` : null;
    actions = { ...materialTaskActions(user, doc, cfg?.role ?? null, sourceBlock, quantityBlock),
      edit: canEditMaterialDraft(user, doc) && !sourceBlock };
  }
  return { ...doc, lines, approvals: approvalRows, actions };
}

export async function listTls(
  q: string,
  opts: { status?: string; jgId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(or(sql`${tlDocs.docNo} ILIKE ${"%" + q + "%"}`, skuLineMatch("tl_lines", "tl_id", tlDocs.id, q)));
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
