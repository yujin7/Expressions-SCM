import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
   batches, flDocs, flLines, jgDocs, skus, users, warehouses, woLines,
} from "@/db/schema";
import { dAdd, dCmp, dNeg, dQty } from "@/server/core/decimal";
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
  requireRealtimeWarehouse, lockMatflowJg,
} from "./common-notes";
import { createFlSchema } from "./schemas";
import { expandOutboundLinesForBatchPosting } from "@/server/modules/inventory/batch-allocation";
import { skuLineMatch } from "@/server/core/doc-search";

/**
 * 发料单 FL（《01》§3/§4）：自有仓 → 委外仓，按 wo_line 预填；
 * 超发（逐物料 累计已批发料+本单 > wo_line 毛需求）须管理员审批（《02》§3）。
 * 过账 fl_issue：每行两腿 from−/to+（sourceLineId=±行id），审批即瞬时执行完成。
 */

type FlRow = typeof flDocs.$inferSelect;
type FlLineRow = typeof flLines.$inferSelect;

// ---------- 创建 ----------

export async function createFl(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<FlRow> {
  requireAnyRole(user, "warehouse");
  const v = createFlSchema.parse(input);
  const db = await resolveDb(dbArg);

  const jg = await getJgForMatflow(db, v.jgId);
  // 收料仓自动定位：该加工厂的委外仓（不由前端传入，防错仓）
  const toWh = await getOutsourceWarehouseOf(db, jg.supplierId);
  await requireRealtimeWarehouse(db, v.fromWarehouseId, "发料源仓");

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
        createdBy: user.id,
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
      userId: user.id, entity: "fl", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, jgId: jg.id, toWarehouseId: toWh.id, lineCount: allocatedLines.length },
    });
    return doc;
  });
}

// ---------- 提交 ----------

export async function submitFl(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<FlRow> {
  const db = await resolveDb(dbArg);
  const [doc]: FlRow[] = await db.select().from(flDocs).where(eq(flDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  if (doc.createdBy !== user.id && !user.roles.includes("warehouse") && !user.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/仓管/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  const updated: FlRow[] = await db
    .update(flDocs)
    .set({ status: "pending", version: sql`${flDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(flDocs.id, id), eq(flDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "fl", entityId: id, action: "submit" });
  return updated[0];
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

/** 该 JG 已批准生效 FL 的逐物料累计发料（可排除某单——审批中的本单） */
async function issuedCumBySku(db: AnyDb, jgId: number, excludeFlId?: number): Promise<Map<number, string>> {
  const conds = [eq(flDocs.jgId, jgId), inArray(flDocs.status, [...ACTIVE_DOC_STATUSES])];
  if (excludeFlId != null) conds.push(ne(flDocs.id, excludeFlId));
  const rows: { skuId: number; qty: string }[] = await db
    .select({ skuId: flLines.skuId, qty: flLines.qty })
    .from(flLines)
    .innerJoin(flDocs, eq(flLines.flId, flDocs.id))
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
      await lockMatflowJg(tx, doc.jgId);

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
      await getJgForMatflow(tx, doc.jgId);

      const lines: FlLineRow[] = await tx.select().from(flLines).where(eq(flLines.flId, id)).orderBy(flLines.id);
      if (lines.length === 0) throw new ApiError(409, "发料单无行，不可审批过账");
      const [jg]: (typeof jgDocs.$inferSelect)[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, doc.jgId));
      if (!jg) throw new ApiError(500, `发料单挂空 JG: #${doc.jgId}`);

      // 超发规则（《02》§3）：逐物料 (累计已批发料 + 本单) > wo_line 毛需求 → 仅管理员可批。
      // 校验失败整个事务回滚（审批记录一并撤销），管理员重批为新一次审批动作。
      const gross = await grossReqBySku(tx, jg.woId);
      const cum = await issuedCumBySku(tx, doc.jgId, id);
      const thisBySku = new Map<number, string>();
      for (const l of lines) thisBySku.set(l.skuId, dAdd(thisBySku.get(l.skuId) ?? "0", l.qty));
      const overIssue = [...thisBySku.entries()].some(([skuId, qty]) => {
        const total = dAdd(cum.get(skuId) ?? "0", qty);
        return dCmp(total, gross.get(skuId) ?? "0") > 0;
      });
      if (overIssue && !actor.roles.includes("admin")) {
        throw new ApiError(403, "超发需管理员审批");
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

export async function getFl(id: number, dbArg?: AnyDb) {
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
    .leftJoin(batches, eq(flLines.batchId, batches.id))
    .where(eq(flLines.flId, id))
    .orderBy(flLines.id);

  // 需求对照（逐物料）：毛需求（wo_line）vs 累计已批发料（含本单若已生效）
  const [jg]: { woId: number }[] = await db
    .select({ woId: jgDocs.woId })
    .from(jgDocs)
    .where(eq(jgDocs.id, doc.jgId));
  const gross = await grossReqBySku(db, jg.woId);
  const cum = await issuedCumBySku(db, doc.jgId);
  const requirements = [...new Set(lines.map((l) => l.skuId))].map((skuId) => ({
    skuId,
    grossReq: gross.get(skuId) ?? "0",
    issuedCum: cum.get(skuId) ?? "0",
  }));

  const approvalRows = await loadApprovalHistory(db, "fl", id);

  return { ...doc, lines, requirements, approvals: approvalRows };
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
