import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
   approvalConfigs, batches, flDocs, flLines, jgDocs, skus, stockLedger, users, warehouses, woDocs, woLines,
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
import { createFlSchema, updateFlSchema } from "./schemas";
import { outboundBatchBlock } from "@/server/posting/batch-eligibility";
import { expandOutboundLinesForBatchPosting } from "@/server/modules/inventory/batch-allocation";
import { skuLineMatch } from "@/server/core/doc-search";
import { canEditFlDraft, materialExcess, materialTaskActions } from "./task-actions";

/**
 * 发料单 FL（《01》§3/§4）：自有仓 → 委外仓，按 wo_line 预填；
 * 超发（逐物料 累计已批发料+本单 > wo_line 毛需求）须管理员审批（《02》§3）。
 * 过账 fl_issue：每行两腿 from−/to+（sourceLineId=±行id），审批即瞬时执行完成。
 */

type FlRow = typeof flDocs.$inferSelect;
type FlLineRow = typeof flLines.$inferSelect;

// ---------- 创建 ----------

export async function createFl(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<FlRow> {
  const v = createFlSchema.parse(input);
  const db = await resolveDb(dbArg);

  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user);
  requireAnyRole(actor, "warehouse");
  await lockMatflowJg(tx, v.jgId);
  const jg = await getJgForMatflow(tx, v.jgId);
  const toWh = await getOutsourceWarehouseOf(tx, jg.supplierId, v.toWarehouseId);
  await lockMatflowWarehouses(tx, [v.fromWarehouseId, toWh.id]);
  await getOutsourceWarehouseOf(tx, jg.supplierId, toWh.id);
  await requireRealtimeWarehouse(tx, v.fromWarehouseId, "发料源仓");

  const skuIds = [...new Set(v.lines.map((l) => l.skuId))];
  const skuRows: { id: number; active: boolean }[] = await tx
    .select({ id: skus.id, active: skus.active })
    .from(skus)
    .where(inArray(skus.id, skuIds));
  const activeSku = new Set(skuRows.filter((s) => s.active).map((s) => s.id));
  for (const sid of skuIds) {
    if (!activeSku.has(sid)) throw new ApiError(400, `SKU 不存在或已停用: #${sid}`);
  }

    const allocatedLines = await expandOutboundLinesForBatchPosting(tx, v.fromWarehouseId, v.lines);
    const docNo = await nextDocNo(tx, "FL");
    const [doc]: FlRow[] = await tx
      .insert(flDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        jgId: jg.id,
        fromWarehouseId: v.fromWarehouseId,
        toWarehouseId: toWh.id,
        createdBy: actor.id,
      })
      .returning();
    await tx.insert(flLines).values(
      allocatedLines.map((l) => ({
        flId: doc.id,
        skuId: l.skuId,
        qty: dQty(l.qty),
        batchId: l.batchId ?? null,
      })),
    );
    await writeAudit(tx, {
      userId: actor.id, entity: "fl", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, jgId: jg.id, toWarehouseId: toWh.id, lineCount: allocatedLines.length },
    });
    return doc;
  });
}

// ---------- 草稿纠正：原单/原审批历史保留，不过账、不自动换批 ----------

export async function updateFl(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<FlRow> {
  const v = updateFlSchema.parse(input), db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "warehouse");
    const [source]: FlRow[] = await tx.select().from(flDocs).where(eq(flDocs.id, id));
    if (!source) throw new ApiError(404, "发料单不存在");
    await lockMatflowJg(tx, source.jgId);
    const [doc]: FlRow[] = await tx.select().from(flDocs).where(eq(flDocs.id, id)).for("update");
    if (!doc || doc.jgId !== source.jgId) throw new ApiError(409, "发料来源已变化，请重新读取核对");
    if (doc.status !== "draft") throw new ApiError(409, "仅草稿或已驳回的发料单可修改；待审批先驳回，已生效单据不可改写");
    if (!canEditFlDraft(actor, doc)) throw new ApiError(403, "仅当前具备仓管权限的制单人或管理员可修改发料草稿");
    if (doc.version !== v.version) throw new ApiError(409, "单据版本已变化，请重新读取核对，未覆盖他人的修改");
    const [posted] = await tx.select({ id: stockLedger.id }).from(stockLedger)
      .where(and(eq(stockLedger.sourceDocType, "fl_issue"), eq(stockLedger.sourceDocId, id))).limit(1);
    if (posted) throw new ApiError(409, "原单已有库存流水，不可按草稿改写；请联系仓管核对纠错");
    const jg = await getJgForMatflow(tx, doc.jgId);
    await lockMatflowWarehouses(tx, [doc.fromWarehouseId, doc.toWarehouseId, v.fromWarehouseId, v.toWarehouseId]);
    await requireRealtimeWarehouse(tx, v.fromWarehouseId, "发料源仓");
    await getOutsourceWarehouseOf(tx, jg.supplierId, v.toWarehouseId);
    const ids = [...new Set(v.lines.map(line => line.skuId))];
    const eligible: { id: number }[] = await tx.select({ id: skus.id }).from(skus).where(and(inArray(skus.id, ids), eq(skus.active, true)));
    if (eligible.length !== ids.length) throw new ApiError(409, "明细包含不存在或已停用的SKU，请重新核对");
    const lines = v.lines.map(line => ({ skuId: line.skuId, qty: dQty(line.qty), batchId: line.batchId }));
    const block = await outboundBatchBlock(tx, { sourceDocType: "fl_issue", sourceDocId: id, action: "post",
      lines: lines.map((line, index) => ({ ...line, sourceLineId: index + 1, warehouseId: v.fromWarehouseId, qtyDelta: dNeg(line.qty) })) });
    if (block) throw new PostingError(block.code, block.message);
    const beforeLines: FlLineRow[] = await tx.select().from(flLines).where(eq(flLines.flId, id)).orderBy(flLines.id);
    const [saved]: FlRow[] = await tx.update(flDocs).set({ fromWarehouseId: v.fromWarehouseId, toWarehouseId: v.toWarehouseId,
      remark: v.remark ?? null, version: sql`${flDocs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(flDocs.id, id), eq(flDocs.status, "draft"), eq(flDocs.version, v.version))).returning();
    if (!saved) throw new ApiError(409, "版本冲突，请重新读取核对");
    await tx.delete(flLines).where(eq(flLines.flId, id));
    const afterLines: FlLineRow[] = await tx.insert(flLines).values(lines.map(line => ({ ...line, flId: id }))).returning();
    await writeAudit(tx, { userId: actor.id, entity: "fl", entityId: id, action: "update_draft",
      before: { version: doc.version, fromWarehouseId: doc.fromWarehouseId, toWarehouseId: doc.toWarehouseId, remark: doc.remark, lines: beforeLines },
      after: { version: saved.version, fromWarehouseId: saved.fromWarehouseId, toWarehouseId: saved.toWarehouseId, remark: saved.remark, lines: afterLines } });
    return saved;
  });
}

// ---------- 提交 ----------

export async function submitFl(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<FlRow> {
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user);
  const [source]: FlRow[] = await tx.select().from(flDocs).where(eq(flDocs.id, id));
  if (!source) throw new ApiError(404, "单据不存在");
  // Match approval/closure lock order: JG authority before its material document.
  await lockMatflowJg(tx, source.jgId);
  const [doc]: FlRow[] = await tx.select().from(flDocs).where(eq(flDocs.id, id)).for("update");
  if (!doc || doc.jgId !== source.jgId) throw new ApiError(409, "发料来源已变化，请重新读取核对");
  if (doc.createdBy !== actor.id && !actor.roles.includes("warehouse") && !actor.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/仓管/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  await getJgForMatflow(tx, doc.jgId);
  const updated: FlRow[] = await tx
    .update(flDocs)
    .set({ status: "pending", version: sql`${flDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(flDocs.id, id), eq(flDocs.version, version), eq(flDocs.status, "draft")))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(tx, { userId: actor.id, entity: "fl", entityId: id, action: "submit" });
  return updated[0];
  });
}

// ---------- 需求/累计口径（超发校验与详情对照共用） ----------

/** 该 JG 的 wo_line 毛需求（逐物料合并；同物料多行求和） */
async function grossReqBySku(db: AnyDb, woId: number): Promise<Map<number, string>> {
  const rows: { skuId: number; grossReq: string }[] = await db
    .select({ skuId: woLines.materialSkuId, grossReq: woLines.grossReq })
    .from(woLines)
    .where(eq(woLines.woId, woId));
  const m = new Map<number, string>();
  for (const r of rows) m.set(r.skuId, dAdd(m.get(r.skuId) ?? "0", r.grossReq));
  return m;
}

/** WO毛需求是全单额度，累计须跨其全部JG；退料不自动恢复额度。 */
async function issuedCumByWoSku(db: AnyDb, woId: number, excludeFlId?: number): Promise<Map<number, string>> {
  const conds = [eq(jgDocs.woId, woId), inArray(flDocs.status, [...ACTIVE_DOC_STATUSES])];
  if (excludeFlId != null) conds.push(ne(flDocs.id, excludeFlId));
  const rows: { skuId: number; qty: string }[] = await db
    .select({ skuId: flLines.skuId, qty: flLines.qty })
    .from(flLines)
    .innerJoin(flDocs, eq(flLines.flId, flDocs.id))
    .innerJoin(jgDocs, eq(flDocs.jgId, jgDocs.id))
    .where(and(...conds));
  const m = new Map<number, string>();
  for (const r of rows) m.set(r.skuId, dAdd(m.get(r.skuId) ?? "0", r.qty));
  return m;
}

// ---------- 审批（超发规则 + 过账 fl_issue + 瞬时完成，同一事务） ----------

export async function approveFl(
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
      const [doc]: FlRow[] = await tx.select().from(flDocs).where(eq(flDocs.id, id));
      if (!doc) throw new ApiError(404, "单据不存在");
      const [source]: { woId: number }[] = await tx.select({ woId: jgDocs.woId }).from(jgDocs).where(eq(jgDocs.id, doc.jgId));
      if (!source) throw new ApiError(409, "加工通知单来源缺失，请核对");
      // Serialize siblings before JG/FL/warehouse locks. Different source warehouses must
      // not give two approvals independent snapshots of the same whole-WO allowance.
      const [workOrder] = await tx.select({ id: woDocs.id }).from(woDocs).where(eq(woDocs.id, source.woId)).for("update");
      if (!workOrder) throw new ApiError(409, "委外工单来源缺失，请核对");
      await lockMatflowJg(tx, doc.jgId);
      const [lockedSource]: { woId: number }[] = await tx.select({ woId: jgDocs.woId }).from(jgDocs).where(eq(jgDocs.id, doc.jgId));
      if (lockedSource?.woId !== source.woId) throw new ApiError(409, "加工通知单所属工单已变化，请重新读取");

      const r = await approveDoc(tx, {
        docType: "fl",
        table: flDocs,
        docId: id,
        approver: actor,
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r; // 重试短路：不重复过账（post 自身幂等，双保险）
      await writeAudit(tx, {
        userId: actor.id, entity: "fl", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      if (v.action === "reject") return r;
      const sourceJg = await getJgForMatflow(tx, doc.jgId);
      await lockMatflowWarehouses(tx, [doc.fromWarehouseId, doc.toWarehouseId]);
      await getOutsourceWarehouseOf(tx, sourceJg.supplierId, doc.toWarehouseId);
      await requireRealtimeWarehouse(tx, doc.fromWarehouseId, "发料源仓");

      const lines: FlLineRow[] = await tx.select().from(flLines).where(eq(flLines.flId, id)).orderBy(flLines.id);
      if (lines.length === 0) throw new ApiError(409, "发料单无行，不可审批过账");
      const [jg]: (typeof jgDocs.$inferSelect)[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, doc.jgId));
      if (!jg) throw new ApiError(500, `发料单挂空 JG: #${doc.jgId}`);

      // 超发规则（《02》§3）：逐物料 (累计已批发料 + 本单) > wo_line 毛需求 → 仅管理员可批。
      // 校验失败整个事务回滚（审批记录一并撤销），管理员重批为新一次审批动作。
      const gross = await grossReqBySku(tx, jg.woId);
      const cum = await issuedCumByWoSku(tx, jg.woId, id);
      const relevantCum = new Map(lines.map(l => [l.skuId, cum.get(l.skuId) ?? "0"]));
      const overIssue = Boolean(materialExcess(lines, relevantCum, gross));
      if (overIssue && !actor.roles.includes("admin")) {
        throw new ApiError(403, "同工单跨加工批次累计超发需管理员审批，请核对其他批次已发量");
      }

      // 过账 fl_issue：一事件；每行两腿 from−（sourceLineId=行id）/ to+（sourceLineId=−行id）
      await post(tx, {
        sourceDocType: "fl_issue",
        sourceDocId: id,
        action: "post",
        lines: lines.flatMap((l) => [
          { sourceLineId: l.id, skuId: l.skuId, warehouseId: doc.fromWarehouseId, batchId: l.batchId, qtyDelta: dNeg(l.qty) },
          { sourceLineId: -l.id, skuId: l.skuId, warehouseId: doc.toWarehouseId, batchId: l.batchId, qtyDelta: dQty(l.qty) },
        ]),
      });

      const finalStatus = await completeApprovedDoc(tx, flDocs, id);
      await writeAudit(tx, {
        userId: actor.id, entity: "fl", entityId: id, action: "post_and_complete",
        after: { via: "approve", overIssue },
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

export async function getFl(id: number, dbArg?: AnyDb, user?: SessionUser) {
  const db = await resolveDb(dbArg);
  const fromWh = alias(warehouses, "wh_from");
  const toWh = alias(warehouses, "wh_to");
  const [doc] = await db
    .select({
      id: flDocs.id,
      docNo: flDocs.docNo,
      status: flDocs.status,
      remark: flDocs.remark,
      version: flDocs.version,
      jgId: flDocs.jgId,
      jgDocNo: jgDocs.docNo,
      supplierId: jgDocs.supplierId,
      fromWarehouseId: flDocs.fromWarehouseId,
      fromWarehouseName: fromWh.name,
      toWarehouseId: flDocs.toWarehouseId,
      toWarehouseName: toWh.name,
      createdBy: flDocs.createdBy,
      createdAt: flDocs.createdAt,
      createdByName: users.name,
    })
    .from(flDocs)
    .innerJoin(jgDocs, eq(flDocs.jgId, jgDocs.id))
    .innerJoin(fromWh, eq(flDocs.fromWarehouseId, fromWh.id))
    .innerJoin(toWh, eq(flDocs.toWarehouseId, toWh.id))
    .leftJoin(users, eq(flDocs.createdBy, users.id))
    .where(eq(flDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines = await db
    .select({
      id: flLines.id,
      skuId: flLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      qty: flLines.qty,
      batchId: flLines.batchId,
      batchNo: batches.batchNo,
      expiryDate: batches.expiryDate,
    })
    .from(flLines)
    .innerJoin(skus, eq(flLines.skuId, skus.id))
    .leftJoin(batches, and(eq(flLines.batchId, batches.id), eq(flLines.skuId, batches.skuId)))
    .where(eq(flLines.flId, id))
    .orderBy(flLines.id);

  // 需求对照（逐物料）：毛需求（wo_line）vs 累计已批发料（含本单若已生效）
  const [jg]: { woId: number }[] = await db
    .select({ woId: jgDocs.woId })
    .from(jgDocs)
    .where(eq(jgDocs.id, doc.jgId));
  const gross = await grossReqBySku(db, jg.woId);
  const cum = await issuedCumByWoSku(db, jg.woId);
  const requirements = [...new Set(lines.map((l) => l.skuId))].map((skuId) => ({
    skuId,
    grossReq: gross.get(skuId) ?? "0",
    issuedCum: cum.get(skuId) ?? "0",
  }));

  const approvalRows = await loadApprovalHistory(db, "fl", id);

  let actions;
  if (user) {
    const [cfg] = await db.select({ role: approvalConfigs.approverRole }).from(approvalConfigs).where(eq(approvalConfigs.docType, "fl"));
    const sourceBlock = await matflowSourceBlock(db, doc.jgId, "issue");
    const relevantCum = new Map(lines.map(l => [l.skuId, cum.get(l.skuId) ?? "0"]));
    const quantityBlock = !lines.length ? "发料单无明细，请核对单据。"
      : materialExcess(lines, relevantCum, gross) && !user.roles.includes("admin") ? "本单会超出工单毛需求，超发需管理员审批。" : null;
    actions = { ...materialTaskActions(user, doc, cfg?.role ?? null, sourceBlock, quantityBlock),
      edit: canEditFlDraft(user, doc) && !sourceBlock };
  }
  return { ...doc, lines, requirements, approvals: approvalRows, actions };
}

export async function listFls(
  q: string,
  opts: { status?: string; jgId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(or(sql`${flDocs.docNo} ILIKE ${"%" + q + "%"}`, skuLineMatch("fl_lines", "fl_id", flDocs.id, q)));
  if (opts.status) conds.push(eq(flDocs.status, opts.status as DocStatus));
  if (opts.jgId) conds.push(eq(flDocs.jgId, opts.jgId));
  const where = conds.length ? and(...conds) : undefined;

  const fromWh = alias(warehouses, "wh_from");
  const toWh = alias(warehouses, "wh_to");
  const lineAgg = db
    .select({ flId: flLines.flId, lineCount: sql<number>`count(*)::int`.as("agg_line_count") })
    .from(flLines)
    .groupBy(flLines.flId)
    .as("la");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: flDocs.id,
        docNo: flDocs.docNo,
        status: flDocs.status,
        jgId: flDocs.jgId,
        jgDocNo: jgDocs.docNo,
        fromWarehouseName: fromWh.name,
        toWarehouseName: toWh.name,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        createdByName: users.name,
        createdAt: flDocs.createdAt,
      })
      .from(flDocs)
      .innerJoin(jgDocs, eq(flDocs.jgId, jgDocs.id))
      .innerJoin(fromWh, eq(flDocs.fromWarehouseId, fromWh.id))
      .innerJoin(toWh, eq(flDocs.toWarehouseId, toWh.id))
      .leftJoin(lineAgg, eq(lineAgg.flId, flDocs.id))
      .leftJoin(users, eq(flDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(flDocs.createdAt), desc(flDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(flDocs).where(where),
  ]);
  return { rows, total };
}
