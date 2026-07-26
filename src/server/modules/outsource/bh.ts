import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {  bhDocs, bhLines, skus, users } from "@/db/schema";
import { dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approveDoc, loadApprovalHistory } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb, rethrowApproval } from "./common";
import { approveDocSchema, createBhSchema } from "./schemas";

/** 备货申请单 BH（《02》§3：运营发起，PMC 审批） */

type BhRow = typeof bhDocs.$inferSelect;

export async function createBh(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<BhRow> {
  requireAnyRole(user, "ops");
  const v = createBhSchema.parse(input);
  const db = await resolveDb(dbArg);

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
    const docNo = await nextDocNo(tx, "BH");
    const [doc]: BhRow[] = await tx
      .insert(bhDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        // 集成阶段如需独立列再迁移（诚实标注，勿当正式口径）。
        orderType: v.orderType ?? null,
        createdBy: user.id,
      })
      .returning();
    await tx.insert(bhLines).values(
      v.lines.map((l) => ({
        bhId: doc.id,
        skuId: l.skuId,
        qty: dQty(l.qty),
        expectDate: l.expectDate ?? null,
      })),
    );
    await writeAudit(tx, {
      userId: user.id, entity: "bh", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, lineCount: v.lines.length, orderType: v.orderType ?? null },
    });
    return doc;
  });
}

export async function submitBh(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<BhRow> {
  const db = await resolveDb(dbArg);
  const [doc]: BhRow[] = await db.select().from(bhDocs).where(eq(bhDocs.id, id));
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
  const updated: BhRow[] = await db
    .update(bhDocs)
    .set({ status: target, version: sql`${bhDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(bhDocs.id, id), eq(bhDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "bh", entityId: id, action: "submit" });
  return updated[0];
}

export async function approveBh(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = approveDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const r = await approveDoc(tx, {
        docType: "bh",
        table: bhDocs,
        docId: id,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "bh", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      return r;
    }).then(async (r: { status: string; idempotent: boolean }) => {
      // D33 钩子①（事务外、失败不阻断）：BH 审批通过 → 自动 WO 草稿（开关默认关）
      if (r.status === "approved" && !r.idempotent) {
        const { hookAfterBhApprove } = await import("./auto-chain");
        await hookAfterBhApprove(user, id, dbArg);
      }
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

// ---------- 查询 ----------

export async function getBh(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: bhDocs.id,
      docNo: bhDocs.docNo,
      status: bhDocs.status,
      remark: bhDocs.remark,
      orderType: sql`coalesce(${bhDocs.orderType}, ${bhDocs.purpose})`, // W5：真列为准，历史 purpose 兼容
      version: bhDocs.version,
      createdBy: bhDocs.createdBy,
      createdAt: bhDocs.createdAt,
      createdByName: users.name,
    })
    .from(bhDocs)
    .leftJoin(users, eq(bhDocs.createdBy, users.id))
    .where(eq(bhDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  const lines = await db
    .select({
      id: bhLines.id,
      skuId: bhLines.skuId,
      skuCode: skus.code,
      skuName: skus.name,
      baseUom: skus.baseUom,
      qty: bhLines.qty,
      expectDate: bhLines.expectDate,
    })
    .from(bhLines)
    .innerJoin(skus, eq(bhLines.skuId, skus.id))
    .where(eq(bhLines.bhId, id))
    .orderBy(bhLines.id);

  const approvalRows = await loadApprovalHistory(db, "bh", id);

  return { ...doc, lines, approvals: approvalRows };
}

export async function listBhs(
  q: string,
  opts: { status?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(sql`${bhDocs.docNo} ILIKE ${"%" + q + "%"}`);
  if (opts.status) conds.push(eq(bhDocs.status, opts.status as DocStatus));
  const where = conds.length ? and(...conds) : undefined;

  const lineAgg = db
    .select({
      bhId: bhLines.bhId,
      lineCount: sql<number>`count(*)::int`.as("agg_line_count"),
    })
    .from(bhLines)
    .groupBy(bhLines.bhId)
    .as("la");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: bhDocs.id,
        docNo: bhDocs.docNo,
        status: bhDocs.status,
        orderType: sql`coalesce(${bhDocs.orderType}, ${bhDocs.purpose})`,
        lineCount: sql<number>`coalesce(${lineAgg.lineCount}, 0)`,
        createdByName: users.name,
        createdAt: bhDocs.createdAt,
      })
      .from(bhDocs)
      .leftJoin(lineAgg, eq(lineAgg.bhId, bhDocs.id))
      .leftJoin(users, eq(bhDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(bhDocs.createdAt), desc(bhDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(bhDocs).where(where),
  ]);
  return { rows, total };
}
