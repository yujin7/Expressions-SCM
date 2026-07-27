import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
   reviewItems, skus, stockBalances, stockDocLines, stockDocs, users, warehouses,
} from "@/db/schema";
import { dMoney, dNeg, dQty } from "@/server/core/decimal";
import {  requireRole, type SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { ApprovalError, approveDoc, loadApprovalHistory } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { post, PostingError, reverse, type AnyDb, type PostingEvent, type PostingLine } from "@/server/posting/post";
import { ApiError } from "@/server/modules/master/common";
import { resolveDb } from "@/server/core/svc";
import {
  approveStockDocSchema, createStockDocSchema, type ManualSubtype, reverseStockDocSchema,
} from "./schemas";
import { expandOutboundLinesForBatchPosting } from "./batch-allocation";

/** 单号前缀（CLAUDE.md）：入库 RK / 出库 CK / 调拨 DB；红字沿用原单前缀 */
const DOC_PREFIX: Record<ManualSubtype, string> = {
  opening: "RK",
  issue_out: "CK",
  sales_out: "CK",
  transfer: "DB",
};

// ---------- 权限守卫（本模块私有；库存写操作=仓库角色，admin 经 requireRole 兜底放行） ----------

export async function guardWarehouseWrite(): Promise<SessionUser> {
  let user: SessionUser;
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    user = await getFreshSessionUser(); // 写操作回查 DB（体检 #5）
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
  try {
    requireRole(user, "warehouse");
  } catch {
    throw new ApiError(403, "无权限执行此操作");
  }
  return user;
}


type StockDocRow = typeof stockDocs.$inferSelect;
type StockDocLineRow = typeof stockDocLines.$inferSelect;

// ---------- 创建 ----------

export async function createStockDoc(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<StockDocRow> {
  const v = createStockDocSchema.parse(input);
  const db = await resolveDb(dbArg);

  // 仓库校验
  const whIds = [...new Set([v.warehouseId, ...(v.toWarehouseId ? [v.toWarehouseId] : [])])];
  const whRows: (typeof warehouses.$inferSelect)[] = await db
    .select()
    .from(warehouses)
    .where(inArray(warehouses.id, whIds));
  const fromWh = whRows.find((w) => w.id === v.warehouseId);
  if (!fromWh || !fromWh.active) throw new ApiError(400, `仓库不存在或已停用: #${v.warehouseId}`);
  // 四类手工单的源仓（期初=入账仓）都必须是实时记账仓——快照仓只吃快照导入
  if (fromWh.accountingMode !== "realtime") {
    throw new ApiError(400, v.subtype === "opening" ? "期初建账仅限实时仓；快照仓 1.1 启用" : "出库/调拨源仓必须是实时仓");
  }
  if (v.subtype === "transfer") {
    const toWh = whRows.find((w) => w.id === v.toWarehouseId);
    if (!toWh || !toWh.active) throw new ApiError(400, `转入仓不存在或已停用: #${v.toWarehouseId}`);
    if (toWh.kind === "snapshot" || toWh.accountingMode === "snapshot") {
      throw new ApiError(400, "快照仓 1.1 启用");
    }
  }

  // SKU 校验：存在且启用（停用=禁新单引用）
  const skuIds = [...new Set(v.lines.map((l) => l.skuId))];
  const skuRows: { id: number; code: string; active: boolean }[] = await db
    .select({ id: skus.id, code: skus.code, active: skus.active })
    .from(skus)
    .where(inArray(skus.id, skuIds));
  const activeSku = new Set(skuRows.filter((s) => s.active).map((s) => s.id));
  for (const sid of skuIds) {
    if (!activeSku.has(sid)) throw new ApiError(400, `SKU 不存在或已停用: #${sid}`);
  }

  return db.transaction(async (tx: AnyDb) => {
    if (v.riskDisposalId) {
      const [disposal]: { refKey: string | null; title: string }[] = await tx
        .select({ refKey: reviewItems.refKey, title: reviewItems.title })
        .from(reviewItems)
        .where(and(
          eq(reviewItems.id, v.riskDisposalId),
          eq(reviewItems.category, "risk_disposal"),
          eq(reviewItems.status, "open"),
        ));
      if (!disposal) throw new ApiError(409, "风险处置登记不存在、已关闭或已被改判");
      if (!disposal.title.startsWith("处置决定：报废评审 ")) {
        throw new ApiError(409, "只有「报废评审」登记可生成报废出库单");
      }
      const linkedSkuCodes = new Set(
        v.lines
          .map((line) => skuRows.find((sku) => sku.id === line.skuId)?.code)
          .filter((code): code is string => Boolean(code)),
      );
      if (linkedSkuCodes.size !== 1 || !disposal.refKey || !linkedSkuCodes.has(disposal.refKey)) {
        throw new ApiError(409, "报废出库明细必须且只能包含该处置登记对应的 SKU");
      }
    }
    const lines = v.subtype === "opening"
      ? v.lines.map((line) => ({ ...line, qty: dQty(line.qty), batchId: line.batchId ?? null }))
      : await expandOutboundLinesForBatchPosting(tx, v.warehouseId, v.lines);
    const docNo = await nextDocNo(tx, DOC_PREFIX[v.subtype]);
    const [doc]: StockDocRow[] = await tx
      .insert(stockDocs)
      .values({
        docNo,
        subtype: v.subtype,
        reason: v.subtype === "transfer" ? (v.reason ?? null) : null,
        remark: v.remark ?? null,
        sourceDocType: v.riskDisposalId ? "risk_disposal" : null,
        sourceDocId: v.riskDisposalId ?? null,
        createdBy: user.id,
      })
      .returning();
    await tx.insert(stockDocLines).values(
      lines.map((l) => ({
        stockDocId: doc.id,
        skuId: l.skuId,
        warehouseId: v.warehouseId,
        toWarehouseId: v.subtype === "transfer" ? v.toWarehouseId : null,
        batchId: l.batchId ?? null,
        qty: dQty(l.qty),
        price: l.price != null ? dMoney(l.price) : null,
      })),
    );
    await writeAudit(tx, {
      userId: user.id, entity: "stock_doc", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, subtype: doc.subtype, lineCount: lines.length },
    });
    return doc;
  });
}

// ---------- 提交 ----------

export async function submitStockDoc(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<StockDocRow> {
  const db = await resolveDb(dbArg);
  const [doc]: StockDocRow[] = await db.select().from(stockDocs).where(eq(stockDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  if (doc.createdBy !== user.id && !user.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人或管理员可提交");
  }
  let target: DocStatus;
  try {
    target = nextStatus(doc.status as DocStatus, "submit");
  } catch (e) {
    if (e instanceof TransitionError) throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
    throw e;
  }
  const updated: StockDocRow[] = await db
    .update(stockDocs)
    .set({ status: target, version: sql`${stockDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(stockDocs.id, id), eq(stockDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "stock_doc", entityId: id, action: "submit" });
  return updated[0];
}

// ---------- 过账事件构造（方向由子类型决定；行数据源=stock_doc_lines） ----------

/**
 * 由单据+行重建过账事件（幂等可重放——红字冲销时按此重建原单事件取负）。
 * 调拨每输入行拆两条：出仓 −（sourceLineId=行id）、入仓 +（sourceLineId=−行id，保证互异）。
 */
function buildPostingEvent(doc: StockDocRow, lines: StockDocLineRow[]): PostingEvent {
  const pls: PostingLine[] = [];
  for (const l of lines) {
    if (doc.subtype === "transfer") {
      if (!l.toWarehouseId) throw new ApiError(500, `调拨行缺转入仓: line#${l.id}`);
      pls.push({ sourceLineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, batchId: l.batchId, qtyDelta: dNeg(l.qty) });
      pls.push({ sourceLineId: -l.id, skuId: l.skuId, warehouseId: l.toWarehouseId, batchId: l.batchId, qtyDelta: dQty(l.qty) });
    } else if (doc.subtype === "opening") {
      pls.push({ sourceLineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, batchId: l.batchId, qtyDelta: dQty(l.qty) });
    } else {
      // issue_out / sales_out：自有仓 −
      pls.push({ sourceLineId: l.id, skuId: l.skuId, warehouseId: l.warehouseId, batchId: l.batchId, qtyDelta: dNeg(l.qty) });
    }
  }
  return { sourceDocType: doc.subtype, sourceDocId: doc.id, action: "post", lines: pls };
}

// ---------- 审批（原子：审批记录+过账+完成态同一事务，失败全量回滚） ----------

export async function approveStockDoc(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveStockDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const [doc]: StockDocRow[] = await tx.select().from(stockDocs).where(eq(stockDocs.id, id));
      if (!doc) throw new ApiError(404, "单据不存在");

      // 1) 通用审批：权限/职责分离/幂等/状态/乐观锁（pending → approved | draft）
      //    体检审计 #2 整改：期初/盘点按子类型映射独立审批配置（《01》§6：期初/盘点=财务），
      //    其余库存单仍走 stock_doc（仓管）。seed 中 opening/count→finance 配置由此启用。
      const approvalDocType =
        doc.subtype === "opening" ? "opening" : doc.subtype === "count_adjust" ? "count" : "stock_doc";
      const r = await approveDoc(tx, {
        docType: approvalDocType,
        table: stockDocs,
        docId: id,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r; // 重试短路：不再过账（post 本身也幂等，双保险）
      await writeAudit(tx, {
        userId: user.id, entity: "stock_doc", entityId: id, action: v.action,
        after: { comment: v.comment ?? null, approvalDocType },
      });
      if (v.action === "reject") return r; // 驳回→草稿，无过账

      // 2) 过账：红字走 reverse(原单事件取负)，其余按子类型 post
      const lines: StockDocLineRow[] = await tx
        .select()
        .from(stockDocLines)
        .where(eq(stockDocLines.stockDocId, id))
        .orderBy(stockDocLines.id);
      if (doc.subtype === "reversal") {
        if (!doc.reversalOfId) throw new ApiError(500, `红字单缺 reversalOfId: #${id}`);
        const [orig]: StockDocRow[] = await tx.select().from(stockDocs).where(eq(stockDocs.id, doc.reversalOfId));
        if (!orig) throw new ApiError(404, `被冲销原单不存在: #${doc.reversalOfId}`);
        const origLines: StockDocLineRow[] = await tx
          .select()
          .from(stockDocLines)
          .where(eq(stockDocLines.stockDocId, orig.id))
          .orderBy(stockDocLines.id);
        await reverse(tx, buildPostingEvent(orig, origLines), doc.id);
      } else {
        await post(tx, buildPostingEvent(doc, lines));
      }

      // 3) 库存单瞬时执行：approved -[start]→ in_progress -[complete]→ completed（走状态机保持合法）
      const inProgress = nextStatus("approved", "start");
      const finalStatus = nextStatus(inProgress, "complete");
      await tx
        .update(stockDocs)
        .set({ status: finalStatus, version: sql`${stockDocs.version} + 1`, updatedAt: new Date() })
        .where(eq(stockDocs.id, id));
      await writeAudit(tx, {
        userId: user.id, entity: "stock_doc", entityId: id, action: "post_and_complete",
        after: { via: "approve", path: "approved→in_progress→completed" },
      });
      if (doc.subtype === "issue_out" && doc.sourceDocType === "risk_disposal" && doc.sourceDocId) {
        const closed: { id: number }[] = await tx
          .update(reviewItems)
          .set({
            status: "done",
            note: `报废出库 ${doc.docNo} 已审批过账，处置自动完成`,
            decidedBy: user.id,
            decidedAt: new Date(),
          })
          .where(and(
            eq(reviewItems.id, doc.sourceDocId),
            eq(reviewItems.category, "risk_disposal"),
            eq(reviewItems.status, "open"),
          ))
          .returning({ id: reviewItems.id });
        if (closed.length === 1) {
          await writeAudit(tx, {
            userId: user.id,
            entity: "risk_disposal",
            entityId: doc.sourceDocId,
            action: "auto_close_after_scrap",
            after: { stockDocId: doc.id, docNo: doc.docNo },
          });
        }
      }
      if (doc.subtype === "reversal" && doc.reversalOfId) {
        const [original]: StockDocRow[] = await tx
          .select()
          .from(stockDocs)
          .where(eq(stockDocs.id, doc.reversalOfId));
        if (
          original?.subtype === "issue_out"
          && original.sourceDocType === "risk_disposal"
          && original.sourceDocId
        ) {
          const reopened: { id: number }[] = await tx
            .update(reviewItems)
            .set({
              status: "open",
              note: `报废出库 ${original.docNo} 已由红字 ${doc.docNo} 冲销，处置重新打开`,
              decidedBy: null,
              decidedAt: null,
            })
            .where(and(
              eq(reviewItems.id, original.sourceDocId),
              eq(reviewItems.category, "risk_disposal"),
              eq(reviewItems.status, "done"),
            ))
            .returning({ id: reviewItems.id });
          if (reopened.length === 1) {
            await writeAudit(tx, {
              userId: user.id,
              entity: "risk_disposal",
              entityId: original.sourceDocId,
              action: "reopen_after_scrap_reversal",
              after: {
                originalStockDocId: original.id,
                reversalStockDocId: doc.id,
              },
            });
          }
        }
      }
      return { status: finalStatus, idempotent: false };
    });
  } catch (e) {
    if (e instanceof PostingError && e.code === "NEGATIVE_STOCK") {
      throw await enrichNegativeStock(db, id, e);
    }
    if (e instanceof ApprovalError) throw mapApprovalError(e);
    throw e;
  }
}

const APPROVAL_STATUS: Record<string, number> = {
  NO_CONFIG: 500,
  ROLE_FORBIDDEN: 403,
  NOT_APPROVER: 403,
  SELF_APPROVAL: 403,
  NOT_FOUND: 404,
  BAD_STATUS: 409,
  VERSION_CONFLICT: 409,
};

/** UX 走查 Top-3：错误码人话化——普通用户读不懂 SELF_APPROVAL */
const APPROVAL_HUMAN: Record<string, string> = {
  NO_CONFIG: "系统缺少该单据的审批配置，请联系管理员",
  ROLE_FORBIDDEN: "您的角色无权审批该单据",
  NOT_APPROVER: "您不是审批人（需要审批人权限）",
  SELF_APPROVAL: "不能审批自己提交的单据（职责分离）",
  NOT_FOUND: "单据不存在",
  BAD_STATUS: "当前状态不可审批",
  VERSION_CONFLICT: "单据已被他人更新，请刷新后重试",
};

function mapApprovalError(e: ApprovalError): ApiError {
  return new ApiError(APPROVAL_STATUS[e.code] ?? 500, APPROVAL_HUMAN[e.code] ?? e.message);
}

/** 负库存 → 409 "库存不足：<sku>@<仓库>（现有 X，需出 Y）"；事务已整体回滚后用根连接补查明细 */
async function enrichNegativeStock(db: AnyDb, docId: number, e: PostingError): Promise<ApiError> {
  const m = /sku#(\d+) warehouse#(\d+)/.exec(e.message);
  if (!m) return new ApiError(409, `库存不足：${e.message}`);
  const skuId = Number(m[1]);
  const warehouseId = Number(m[2]);
  const [skuRow]: { code: string; name: string }[] = await db
    .select({ code: skus.code, name: skus.name })
    .from(skus)
    .where(eq(skus.id, skuId));
  const [whRow]: { name: string }[] = await db
    .select({ name: warehouses.name })
    .from(warehouses)
    .where(eq(warehouses.id, warehouseId));
  const [bal]: { qty: string | null }[] = await db
    .select({ qty: sql<string | null>`sum(${stockBalances.qty})` })
    .from(stockBalances)
    .where(and(eq(stockBalances.skuId, skuId), eq(stockBalances.warehouseId, warehouseId)));
  const [need]: { qty: string | null }[] = await db
    .select({ qty: sql<string | null>`sum(${stockDocLines.qty})` })
    .from(stockDocLines)
    .where(and(eq(stockDocLines.stockDocId, docId), eq(stockDocLines.skuId, skuId)));
  const skuLabel = skuRow ? `${skuRow.code} ${skuRow.name}`.trim() : `sku#${skuId}`;
  const whLabel = whRow?.name ?? `warehouse#${warehouseId}`;
  return new ApiError(
    409,
    `库存不足：${skuLabel}@${whLabel}（现有 ${dQty(bal?.qty ?? "0")}，需出 ${dQty(need?.qty ?? "0")}）`,
  );
}

// ---------- 红字冲销（R12：无反审批，纠错唯一路径） ----------

export async function reverseStockDoc(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<StockDocRow> {
  const v = reverseStockDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [orig]: StockDocRow[] = await tx.select().from(stockDocs).where(eq(stockDocs.id, id));
    if (!orig) throw new ApiError(404, "单据不存在");
    if (orig.subtype === "reversal") throw new ApiError(400, "红字单不可再冲销（无套娃）");
    if (orig.status !== "completed") throw new ApiError(409, `仅已完成单据可红字冲销，当前状态: ${orig.status}`);
    // 一单最多冲销一次（非作废红字已存在 → 拒绝）
    const dup: { id: number }[] = await tx
      .select({ id: stockDocs.id })
      .from(stockDocs)
      .where(and(eq(stockDocs.reversalOfId, id), ne(stockDocs.status, "void")))
      .limit(1);
    if (dup.length > 0) throw new ApiError(409, `该单据已存在红字冲销单: #${dup[0].id}`);

    const origLines: StockDocLineRow[] = await tx
      .select()
      .from(stockDocLines)
      .where(eq(stockDocLines.stockDocId, id))
      .orderBy(stockDocLines.id);
    if (origLines.length === 0) throw new ApiError(500, `原单无行: #${id}`);

    const prefix = orig.docNo.split("-")[0] || "CK";
    const docNo = await nextDocNo(tx, prefix);
    const [doc]: StockDocRow[] = await tx
      .insert(stockDocs)
      .values({
        docNo,
        subtype: "reversal",
        remark: v.reason,
        sourceDocType: "stock_doc",
        sourceDocId: id,
        reversalOfId: id,
        createdBy: user.id,
      })
      .returning();
    await tx.insert(stockDocLines).values(
      origLines.map((l) => ({
        stockDocId: doc.id,
        skuId: l.skuId,
        warehouseId: l.warehouseId,
        toWarehouseId: l.toWarehouseId,
        batchId: l.batchId,
        qty: dQty(l.qty), // 存正数；取负发生在过账 reverse()
        price: l.price,
      })),
    );
    await writeAudit(tx, {
      userId: user.id, entity: "stock_doc", entityId: doc.id, action: "reverse_create",
      after: { docNo: doc.docNo, reversalOfId: id, reason: v.reason, lineCount: origLines.length },
    });
    return doc;
  });
}

// ---------- 查询 ----------

export async function getStockDoc(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc]: (StockDocRow & { createdByName: string | null })[] = await db
    .select({
      id: stockDocs.id,
      docNo: stockDocs.docNo,
      subtype: stockDocs.subtype,
      status: stockDocs.status,
      remark: stockDocs.remark,
      company: stockDocs.company,
      dept: stockDocs.dept,
      project: stockDocs.project,
      version: stockDocs.version,
      closedReason: stockDocs.closedReason,
      sourceDocType: stockDocs.sourceDocType,
      sourceDocId: stockDocs.sourceDocId,
      reversalOfId: stockDocs.reversalOfId,
      createdBy: stockDocs.createdBy,
      createdAt: stockDocs.createdAt,
      updatedAt: stockDocs.updatedAt,
      createdByName: users.name,
    })
    .from(stockDocs)
    .leftJoin(users, eq(stockDocs.createdBy, users.id))
    .where(eq(stockDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines: {
    id: number; skuId: number; skuCode: string; skuName: string; baseUom: string;
    warehouseId: number; toWarehouseId: number | null; batchId: number | null;
    qty: string; price: string | null;
  }[] = await db
    .select({
      id: stockDocLines.id,
      skuId: stockDocLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      warehouseId: stockDocLines.warehouseId,
      toWarehouseId: stockDocLines.toWarehouseId,
      batchId: stockDocLines.batchId,
      qty: stockDocLines.qty,
      price: stockDocLines.price,
    })
    .from(stockDocLines)
    .innerJoin(skus, eq(stockDocLines.skuId, skus.id))
    .where(eq(stockDocLines.stockDocId, id))
    .orderBy(stockDocLines.id);

  // 单头仓库=行仓库（同一单所有行同仓，取首行）
  const warehouseId = lines[0]?.warehouseId ?? null;
  const toWarehouseId = lines[0]?.toWarehouseId ?? null;
  const whIds = [warehouseId, toWarehouseId].filter((x): x is number => x != null);
  const whRows: { id: number; name: string }[] = whIds.length
    ? await db.select({ id: warehouses.id, name: warehouses.name }).from(warehouses).where(inArray(warehouses.id, whIds))
    : [];
  const whName = (wid: number | null) => whRows.find((w) => w.id === wid)?.name ?? null;

  const approvalRows = await loadApprovalHistory(db, ["stock_doc", "opening", "count"], id);

  return {
    id: doc.id,
    docNo: doc.docNo,
    subtype: doc.subtype,
    status: doc.status,
    version: doc.version,
    remark: doc.remark,
    warehouseId,
    warehouseName: whName(warehouseId),
    toWarehouseId,
    toWarehouseName: whName(toWarehouseId),
    reversalOfId: doc.reversalOfId,
    lines: lines.map((l) => ({
      id: l.id, skuId: l.skuId, skuCode: l.skuCode, skuName: l.skuName,
      baseUom: l.baseUom, qty: l.qty, price: l.price,
    })),
    approvals: approvalRows,
    createdByName: doc.createdByName,
    createdAt: doc.createdAt,
  };
}

export async function listStockDocs(
  q: string,
  opts: { status?: string; subtype?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(sql`${stockDocs.docNo} ILIKE ${"%" + q + "%"}`);
  if (opts.status) conds.push(eq(stockDocs.status, opts.status as DocStatus));
  if (opts.subtype) conds.push(eq(stockDocs.subtype, opts.subtype as ManualSubtype));
  const where = conds.length ? and(...conds) : undefined;

  const lineAgg = db
    .select({
      stockDocId: stockDocLines.stockDocId,
      warehouseId: sql<number>`min(${stockDocLines.warehouseId})`.as("agg_wh_id"),
      toWarehouseId: sql<number | null>`min(${stockDocLines.toWarehouseId})`.as("agg_to_wh_id"),
      lineCount: sql<number>`count(*)::int`.as("agg_line_count"),
    })
    .from(stockDocLines)
    .groupBy(stockDocLines.stockDocId)
    .as("la");
  const wh = alias(warehouses, "wh_from");
  const toWh = alias(warehouses, "wh_to");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: stockDocs.id,
        docNo: stockDocs.docNo,
        subtype: stockDocs.subtype,
        status: stockDocs.status,
        warehouseName: wh.name,
        toWarehouseName: toWh.name,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        createdByName: users.name,
        createdAt: stockDocs.createdAt,
      })
      .from(stockDocs)
      .leftJoin(lineAgg, eq(lineAgg.stockDocId, stockDocs.id))
      .leftJoin(wh, eq(lineAgg.warehouseId, wh.id))
      .leftJoin(toWh, eq(lineAgg.toWarehouseId, toWh.id))
      .leftJoin(users, eq(stockDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(stockDocs.createdAt), desc(stockDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(stockDocs).where(where),
  ]);
  return { rows, total };
}
