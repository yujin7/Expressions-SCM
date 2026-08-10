import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
   pdDocs, pdLines, skus, spus, stockBalances, stockDocLines, stockDocs, users, warehouses,
} from "@/db/schema";
import { dAdd, dCmp, dQty, dSub } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { requireRole } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { ApprovalError, approveDoc, loadApprovalHistory } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { post, PostingError, type AnyDb, type PostingLine } from "@/server/posting/post";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { resolveDb } from "@/server/core/svc";
import { participatesInNormalSalesMovement } from "@/server/rules/sku-standardization";

/**
 * 盘点任务（PD）——定期全盘 full / 抽盘 partial（=原 PRD"永续盘点"的落地形式：循环抽点）。
 *
 * 流程：创建（快照账面数）→ 录入实盘 → 提交 → 财务审批（审批域 'count'，职责分离）
 *       → 审批通过时生成一张盘盈亏调整单（stock_doc, subtype=count_adjust, 前缀 CA）
 *       并经 posting registry 过账（sourceDocType='count_adjust'，qtyDelta=实盘−账面，带符号）。
 *
 * 设计决策（v1）：
 * - countedQty 创建时预填=账面数（bookQty）——schema 冻结、pd_lines 无逐行状态列，
 *   "未盘=未改动"在 v1 可接受；差异=countedQty−bookQty ≠ 0 的行。
 * - 调整单前缀取 'CA'（Count Adjust）：doc_counters 按前缀独立计数，
 *   避免与 pd_docs 的 'PD' 前缀在同日互相占号造成阅读混乱。
 * - 调整单在 PD 审批事务内直接落 completed（审批留痕在 PD/count 审批域，
 *   不再走 stock_doc 二次审批——期初/盘点审批域=财务，见 CLAUDE.md/seed）。
 */

const PD_PREFIX = "PD";
const ADJUST_PREFIX = "CA";

// ---------- 输入校验（schemas.ts 归属他人，本模块 zod 就地定义） ----------

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字");

const qtyNonNegative = decStr.refine((s) => dCmp(s, "0") >= 0, "实盘数量不能为负");

export const createCountTaskSchema = z
  .object({
    warehouseId: z.number().int().positive({ message: "必须选择仓库" }),
    mode: z.enum(["full", "partial"], { errorMap: () => ({ message: "模式仅支持 full 全盘 / partial 抽盘" }) }),
    filters: z
      .object({
        q: z.string().trim().max(100).optional(),
        skuIds: z.array(z.number().int().positive()).max(500).optional(),
        categoryId: z.number().int().positive().optional(),
      })
      .optional(),
    remark: z.string().trim().max(500).optional(),
    /** 盘点期（业务日期）。不传按今天（Asia/Shanghai）——补录时可显式指定。 */
    bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "盘点期格式 YYYY-MM-DD").optional(),
  })
  .superRefine((v, ctx) => {
    const f = v.filters;
    const hasFilter = !!f && (!!f.q || (f.skuIds?.length ?? 0) > 0 || f.categoryId != null);
    if (v.mode === "full" && hasFilter) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["filters"], message: "全盘不接受筛选条件（抽盘请选 partial）" });
    }
  });
export type CreateCountTaskInput = z.infer<typeof createCountTaskSchema>;

export const updateCountsSchema = z.object({
  version: z.number().int().positive(),
  lines: z
    .array(z.object({ lineId: z.number().int().positive(), countedQty: qtyNonNegative }))
    .min(1, "至少一行实盘数"),
});

export const approveCountTaskSchema = z.object({
  action: z.enum(["approve", "reject"]),
  comment: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
});

// ---------- 公共 ----------


type PdDocRow = typeof pdDocs.$inferSelect;
type PdLineRow = typeof pdLines.$inferSelect;

const APPROVAL_STATUS: Record<string, number> = {
  NO_CONFIG: 500,
  ROLE_FORBIDDEN: 403,
  NOT_APPROVER: 403,
  SELF_APPROVAL: 403,
  NOT_FOUND: 404,
  BAD_STATUS: 409,
  VERSION_CONFLICT: 409,
};

/** 错误码人话化（与 stock-doc 一致的 UX 口径） */
const APPROVAL_HUMAN: Record<string, string> = {
  NO_CONFIG: "系统缺少盘点单的审批配置，请联系管理员",
  ROLE_FORBIDDEN: "您的角色无权审批盘点单（盘点=财务审批域）",
  NOT_APPROVER: "您不是审批人（需要审批人权限）",
  SELF_APPROVAL: "不能审批自己提交的单据（职责分离）",
  NOT_FOUND: "单据不存在",
  BAD_STATUS: "当前状态不可审批",
  VERSION_CONFLICT: "单据已被他人更新，请刷新后重试",
};

function mapApprovalError(e: ApprovalError): ApiError {
  return new ApiError(APPROVAL_STATUS[e.code] ?? 500, APPROVAL_HUMAN[e.code] ?? e.message);
}

/**
 * 按业务用途把盘点行分成「小样等非销售用途」与「正常销售」两组。
 * 未分类保守计入正常销售——与全站口径一致；这也正是必须先给存量打标的原因。
 */
function summarizeByRole(
  rows: { commercialRole: string; bookQty: string; countedQty: string }[],
): { group: "sample" | "retail"; lineCount: number; bookQty: string; countedQty: string; diffQty: string }[] {
  const acc = {
    sample: { lineCount: 0, bookQty: "0", countedQty: "0" },
    retail: { lineCount: 0, bookQty: "0", countedQty: "0" },
  };
  for (const r of rows) {
    const key = participatesInNormalSalesMovement(r.commercialRole) ? "retail" : "sample";
    acc[key].lineCount += 1;
    acc[key].bookQty = dAdd(acc[key].bookQty, r.bookQty);
    acc[key].countedQty = dAdd(acc[key].countedQty, r.countedQty);
  }
  return (["sample", "retail"] as const).map((group) => ({
    group,
    lineCount: acc[group].lineCount,
    bookQty: acc[group].bookQty,
    countedQty: acc[group].countedQty,
    diffQty: dSub(acc[group].countedQty, acc[group].bookQty),
  }));
}

// ---------- 创建：快照账面数 ----------

export async function createCountTask(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<PdDocRow> {
  const v = createCountTaskSchema.parse(input);
  const db = await resolveDb(dbArg);

  const [wh]: (typeof warehouses.$inferSelect)[] = await db
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, v.warehouseId));
  if (!wh || !wh.active) throw new ApiError(400, `仓库不存在或已停用: #${v.warehouseId}`);
  if (wh.accountingMode !== "realtime") {
    throw new ApiError(400, "盘点仅限实时记账仓——快照仓（保税/E/云）以每日快照对账，不走盘点单");
  }

  return db.transaction(async (tx: AnyDb) => {
    // 账面快照：该仓非零余额行（抽盘按筛选命中；无筛选=全部非零行）
    const conds = [eq(stockBalances.warehouseId, v.warehouseId), sql`${stockBalances.qty} <> 0`];
    const f = v.mode === "partial" ? v.filters : undefined;
    if (f?.q) {
      conds.push(or(ilike(skus.code, `%${f.q}%`), ilike(skus.name, `%${f.q}%`), ilike(spus.nameCn, `%${f.q}%`))!);
    }
    if (f?.skuIds && f.skuIds.length > 0) conds.push(inArray(stockBalances.skuId, f.skuIds));
    if (f?.categoryId != null) conds.push(eq(spus.categoryId, f.categoryId));

    const balanceRows: { skuId: number; batchId: number | null; qty: string }[] = await tx
      .select({ skuId: stockBalances.skuId, batchId: stockBalances.batchId, qty: stockBalances.qty })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .where(and(...conds))
      .orderBy(skus.code, stockBalances.batchId);
    if (balanceRows.length === 0) {
      throw new ApiError(400, v.mode === "partial" ? "筛选条件未命中任何非零库存行，无法创建抽盘任务" : "该仓库当前无非零库存行，无需盘点");
    }

    const docNo = await nextDocNo(tx, PD_PREFIX);
    const [doc]: PdDocRow[] = await tx
      .insert(pdDocs)
      .values({
        docNo,
        warehouseId: v.warehouseId,
        mode: v.mode,
        remark: v.remark ?? null,
        // 按业务日期而不是录入时间归期：补录/次月才录的盘点不能落到错误的期间
        bizDate: v.bizDate ?? todayShanghai(),
        createdBy: user.id,
      })
      .returning();
    await tx.insert(pdLines).values(
      balanceRows.map((b) => ({
        pdId: doc.id,
        skuId: b.skuId,
        batchId: b.batchId,
        bookQty: dQty(b.qty),
        countedQty: dQty(b.qty), // 预填=账面（v1：未改动=未盘）
      })),
    );
    await writeAudit(tx, {
      userId: user.id, entity: "pd_doc", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, mode: v.mode, warehouseId: v.warehouseId, lineCount: balanceRows.length, filters: f ?? null },
    });
    return doc;
  });
}

// ---------- 录入实盘（仅草稿） ----------

export async function updateCounts(user: SessionUser, pdId: number, input: unknown, dbArg?: AnyDb): Promise<PdDocRow> {
  const v = updateCountsSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [doc]: PdDocRow[] = await tx.select().from(pdDocs).where(eq(pdDocs.id, pdId));
    if (!doc) throw new ApiError(404, "盘点单不存在");
    if (doc.status !== "draft") throw new ApiError(409, `仅草稿可录入实盘数，当前状态: ${doc.status}`);
    if (doc.createdBy !== user.id && !user.roles.includes("admin")) {
      try {
        requireRole(user, "warehouse"); // 仓库同事可代录；其余角色拒绝
      } catch {
        throw new ApiError(403, "仅制单人/仓库/管理员可录入实盘数");
      }
    }

    const lineIds = v.lines.map((l) => l.lineId);
    const owned: { id: number }[] = await tx
      .select({ id: pdLines.id })
      .from(pdLines)
      .where(and(eq(pdLines.pdId, pdId), inArray(pdLines.id, lineIds)));
    if (owned.length !== new Set(lineIds).size) {
      throw new ApiError(400, "存在不属于本盘点单的行");
    }
    for (const l of v.lines) {
      await tx.update(pdLines).set({ countedQty: dQty(l.countedQty) }).where(eq(pdLines.id, l.lineId));
    }
    const updated: PdDocRow[] = await tx
      .update(pdDocs)
      .set({ version: sql`${pdDocs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(pdDocs.id, pdId), eq(pdDocs.version, v.version)))
      .returning();
    if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${v.version} 已过期`);
    await writeAudit(tx, {
      userId: user.id, entity: "pd_doc", entityId: pdId, action: "update_counts",
      after: { lineCount: v.lines.length },
    });
    return updated[0];
  });
}

// ---------- 提交 ----------

export async function submitCountTask(user: SessionUser, pdId: number, version: number, dbArg?: AnyDb): Promise<PdDocRow> {
  const db = await resolveDb(dbArg);
  const [doc]: PdDocRow[] = await db.select().from(pdDocs).where(eq(pdDocs.id, pdId));
  if (!doc) throw new ApiError(404, "盘点单不存在");
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
  const updated: PdDocRow[] = await db
    .update(pdDocs)
    .set({ status: target, version: sql`${pdDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(pdDocs.id, pdId), eq(pdDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "pd_doc", entityId: pdId, action: "submit" });
  return updated[0];
}

// ---------- 审批（原子：审批+调整单+过账+完成态同一事务） ----------

export async function approveCountTask(
  user: SessionUser,
  pdId: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean; adjustDocId?: number | null }> {
  const v = approveCountTaskSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const [doc]: PdDocRow[] = await tx.select().from(pdDocs).where(eq(pdDocs.id, pdId));
      if (!doc) throw new ApiError(404, "盘点单不存在");

      // 1) 通用审批：docType='count'（审批域=财务，seed）；SoD/幂等/乐观锁由 approveDoc 保证
      const r = await approveDoc(tx, {
        docType: "count",
        table: pdDocs,
        docId: pdId,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r; // 重试短路（post 幂等双保险）
      await writeAudit(tx, {
        userId: user.id, entity: "pd_doc", entityId: pdId, action: v.action,
        after: { comment: v.comment ?? null, approvalDocType: "count" },
      });
      if (v.action === "reject") return r; // 驳回→草稿，无调整无过账

      // 2) 差异计算（逐行 counted−book，decimal 工具，禁 float）
      const lines: PdLineRow[] = await tx
        .select()
        .from(pdLines)
        .where(eq(pdLines.pdId, pdId))
        .orderBy(pdLines.id);
      const diffs = lines
        .map((l) => ({ line: l, delta: dSub(l.countedQty, l.bookQty) }))
        .filter((d) => dCmp(d.delta, "0") !== 0);

      let adjustDocId: number | null = null;
      if (diffs.length > 0) {
        // 3) 一张盘盈亏调整单（stock_doc, subtype=count_adjust, 前缀 CA）
        //    行 qty 带符号（正=盘盈 负=盘亏），与红字"负数流水"同一表达惯例；
        //    审批留痕在本 PD（count 审批域），调整单直接落 completed。
        const adjDocNo = await nextDocNo(tx, ADJUST_PREFIX);
        const [adj]: (typeof stockDocs.$inferSelect)[] = await tx
          .insert(stockDocs)
          .values({
            docNo: adjDocNo,
            subtype: "count_adjust",
            status: "completed",
            remark: `盘点差异调整（${doc.docNo}）`,
            sourceDocType: "pd",
            sourceDocId: doc.id,
            createdBy: user.id,
          })
          .returning();
        adjustDocId = adj.id;
        const insertedLines: { id: number }[] = await tx
          .insert(stockDocLines)
          .values(
            diffs.map((d) => ({
              stockDocId: adj.id,
              skuId: d.line.skuId,
              warehouseId: doc.warehouseId,
              batchId: d.line.batchId,
              qty: dQty(d.delta), // 带符号：+盘盈 / −盘亏
            })),
          )
          .returning({ id: stockDocLines.id });

        // 4) 过账：唯一合法路径 posting/post.ts；registry 已注册 (count_adjust, post)
        const postingLines: PostingLine[] = diffs.map((d, i) => ({
          sourceLineId: insertedLines[i].id,
          skuId: d.line.skuId,
          warehouseId: doc.warehouseId,
          batchId: d.line.batchId,
          qtyDelta: d.delta, // 带符号 ±
        }));
        await post(tx, { sourceDocType: "count_adjust", sourceDocId: adj.id, action: "post", lines: postingLines });

        // 5) 差异行回填调整单引用
        await tx
          .update(pdLines)
          .set({ adjustDocId: adj.id })
          .where(inArray(pdLines.id, diffs.map((d) => d.line.id)));
        await writeAudit(tx, {
          userId: user.id, entity: "stock_doc", entityId: adj.id, action: "create",
          after: { docNo: adjDocNo, subtype: "count_adjust", sourcePd: doc.docNo, diffLines: diffs.length },
        });
      }

      // 6) 盘点单瞬时执行：approved -[start]→ in_progress -[complete]→ completed
      const inProgress = nextStatus("approved", "start");
      const finalStatus = nextStatus(inProgress, "complete");
      await tx
        .update(pdDocs)
        .set({ status: finalStatus, version: sql`${pdDocs.version} + 1`, updatedAt: new Date() })
        .where(eq(pdDocs.id, pdId));
      await writeAudit(tx, {
        userId: user.id, entity: "pd_doc", entityId: pdId, action: "post_and_complete",
        after: { via: "approve", adjustDocId, diffLines: diffs.length },
      });
      return { status: finalStatus, idempotent: false, adjustDocId };
    });
  } catch (e) {
    if (e instanceof PostingError && e.code === "NEGATIVE_STOCK") {
      throw new ApiError(409, `盘亏调整导致负库存被拒（账面已变动）——请红字/复盘后重建盘点任务：${e.message}`);
    }
    if (e instanceof ApprovalError) throw mapApprovalError(e);
    throw e;
  }
}

// ---------- 查询 ----------

export async function getCountTask(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc]: (PdDocRow & {
    warehouseName: string | null; createdByName: string | null; bizDate: string | null;
  })[] = await db
    .select({
      id: pdDocs.id,
      docNo: pdDocs.docNo,
      status: pdDocs.status,
      mode: pdDocs.mode,
      remark: pdDocs.remark,
      company: pdDocs.company,
      dept: pdDocs.dept,
      project: pdDocs.project,
      version: pdDocs.version,
      closedReason: pdDocs.closedReason,
      warehouseId: pdDocs.warehouseId,
      bizDate: pdDocs.bizDate,
      createdBy: pdDocs.createdBy,
      createdAt: pdDocs.createdAt,
      updatedAt: pdDocs.updatedAt,
      warehouseName: warehouses.name,
      createdByName: users.name,
    })
    .from(pdDocs)
    .leftJoin(warehouses, eq(pdDocs.warehouseId, warehouses.id))
    .leftJoin(users, eq(pdDocs.createdBy, users.id))
    .where(eq(pdDocs.id, id));
  if (!doc) throw new ApiError(404, "盘点单不存在");

  const lineRows: {
    id: number; skuId: number; skuCode: string; skuName: string; barcode: string | null; baseUom: string;
    commercialRole: string;
    batchId: number | null; bookQty: string; countedQty: string; adjustDocId: number | null;
  }[] = await db
    .select({
      id: pdLines.id,
      skuId: pdLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      barcode: skus.barcode,
      baseUom: skus.baseUom,
      commercialRole: skus.commercialRole,
      batchId: pdLines.batchId,
      bookQty: pdLines.bookQty,
      countedQty: pdLines.countedQty,
      adjustDocId: pdLines.adjustDocId,
    })
    .from(pdLines)
    .innerJoin(skus, eq(pdLines.skuId, skus.id))
    .where(eq(pdLines.pdId, id))
    .orderBy(pdLines.id);

  // 调整单号（差异行统一指向同一张 CA 单）
  const adjIds = [...new Set(lineRows.map((l) => l.adjustDocId).filter((x): x is number => x != null))];
  const adjRows: { id: number; docNo: string }[] = adjIds.length
    ? await db.select({ id: stockDocs.id, docNo: stockDocs.docNo }).from(stockDocs).where(inArray(stockDocs.id, adjIds))
    : [];

  const approvalRows = await loadApprovalHistory(db, "count", id);

  return {
    id: doc.id,
    docNo: doc.docNo,
    status: doc.status,
    mode: doc.mode,
    remark: doc.remark,
    version: doc.version,
    warehouseId: doc.warehouseId,
    warehouseName: doc.warehouseName,
    bizDate: doc.bizDate,
    lines: lineRows.map((l) => ({
      ...l,
      diffQty: dSub(l.countedQty, l.bookQty), // 差异=实盘−账面（+盘盈 −盘亏）
    })),
    /**
     * 小样/非小样分组汇总（0727 行动项：「单独标注小样分类，提供给孙明，便于其清晰区分库存类别」）。
     * 判定走共享规则 participatesInNormalSalesMovement，与驾驶舱/风险页同口径；
     * 数量用 decimal 字符串累加，禁 float。
     */
    roleSummary: summarizeByRole(lineRows),
    adjustDocs: adjRows,
    approvals: approvalRows,
    createdByName: doc.createdByName,
    createdAt: doc.createdAt,
  };
}

export async function listCountTasks(
  q: string,
  opts: {
    status?: string; mode?: string; warehouseId?: number;
    /** 盘点期 YYYY-MM，用于「7 月底盘点」这类按期取数 */
    period?: string;
    page: number; pageSize: number;
  },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(sql`${pdDocs.docNo} ILIKE ${"%" + q + "%"}`);
  if (opts.status) conds.push(eq(pdDocs.status, opts.status as DocStatus));
  if (opts.mode) conds.push(eq(pdDocs.mode, opts.mode));
  if (opts.warehouseId) conds.push(eq(pdDocs.warehouseId, opts.warehouseId));
  if (opts.period) conds.push(sql`to_char(${pdDocs.bizDate}, 'YYYY-MM') = ${opts.period}`);
  const where = conds.length ? and(...conds) : undefined;

  // 行聚合：行数 / 差异行数 / 盈亏合计（SQL numeric 运算，非 JS float）
  const lineAgg = db
    .select({
      pdId: pdLines.pdId,
      lineCount: sql<number>`count(*)::int`.as("agg_line_count"),
      diffCount: sql<number>`count(*) filter (where ${pdLines.countedQty} <> ${pdLines.bookQty})::int`.as("agg_diff_count"),
      diffTotal: sql<string>`coalesce(sum(${pdLines.countedQty} - ${pdLines.bookQty}), 0)`.as("agg_diff_total"),
    })
    .from(pdLines)
    .groupBy(pdLines.pdId)
    .as("pla");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: pdDocs.id,
        docNo: pdDocs.docNo,
        status: pdDocs.status,
        mode: pdDocs.mode,
        warehouseName: warehouses.name,
        bizDate: pdDocs.bizDate,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        diffCount: sql<number>`coalesce(${lineAgg.diffCount}, 0)`,
        diffTotal: sql<string>`coalesce(${lineAgg.diffTotal}, 0)`,
        createdByName: users.name,
        createdAt: pdDocs.createdAt,
      })
      .from(pdDocs)
      .leftJoin(lineAgg, eq(lineAgg.pdId, pdDocs.id))
      .leftJoin(warehouses, eq(pdDocs.warehouseId, warehouses.id))
      .leftJoin(users, eq(pdDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(pdDocs.createdAt), desc(pdDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(pdDocs).where(where),
  ]);
  return { rows, total };
}

/**
 * 盘点明细导出（0727 行动项 #1 的交付物）。
 *
 * 「整理 7 月底盘点的小样库存数据，单独标注小样分类，提供给孙明」——
 * 按盘点期取单、按业务用途可筛，一次导出即可交付，不必再手工拼表。
 * 差异在 SQL 里算（numeric 运算，禁 JS float）。
 */
export async function listCountLinesForExport(
  opts: { period?: string; pdId?: number; commercialRole?: string; limit: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.pdId) conds.push(eq(pdDocs.id, opts.pdId));
  if (opts.period) conds.push(sql`to_char(${pdDocs.bizDate}, 'YYYY-MM') = ${opts.period}`);
  if (opts.commercialRole) conds.push(eq(skus.commercialRole, opts.commercialRole));
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        docNo: pdDocs.docNo,
        bizDate: pdDocs.bizDate,
        warehouseName: warehouses.name,
        skuCode: skus.code,
        skuName: skus.name,
        commercialRole: skus.commercialRole,
        baseUom: skus.baseUom,
        bookQty: pdLines.bookQty,
        countedQty: pdLines.countedQty,
        diffQty: sql<string>`(${pdLines.countedQty} - ${pdLines.bookQty})`,
      })
      .from(pdLines)
      .innerJoin(pdDocs, eq(pdLines.pdId, pdDocs.id))
      .innerJoin(skus, eq(pdLines.skuId, skus.id))
      .leftJoin(warehouses, eq(pdDocs.warehouseId, warehouses.id))
      .where(where)
      .orderBy(pdDocs.docNo, skus.code)
      .limit(opts.limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(pdLines)
      .innerJoin(pdDocs, eq(pdLines.pdId, pdDocs.id))
      .innerJoin(skus, eq(pdLines.skuId, skus.id))
      .where(where),
  ]);
  return { rows, total };
}
