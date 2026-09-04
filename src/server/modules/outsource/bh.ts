import { and, desc, eq, exists, inArray, or, sql } from "drizzle-orm";
import {  bhDocs, bhLines, skus, userDataScopes, users } from "@/db/schema";
import type { ScopeUser } from "@/server/core/data-scope";
import { dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approveDoc, loadApprovalHistory, withdrawDoc } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb, rethrowApproval } from "./common";
import { approveDocSchema, createBhSchema, transitionDocSchema, withdrawDocSchema } from "./schemas";
import { skuLineMatch } from "@/server/core/doc-search";
import { transitionDoc } from "@/server/docflow/transition";

/** 备货申请单 BH（《02》§3：运营发起，PMC 审批） */

type BhRow = typeof bhDocs.$inferSelect;

/**
 * 建单事务内的追加写钩子：调用方要在**同一事务边界**补自己的审计/关联时用
 * （CLAUDE.md：所有业务 service 写路径必须在同一事务边界 writeAudit）。
 * 例：NPD 首单（`npd/service.createNpdFirstOrder`）的 first_order_draft 审计——
 * 此前写在 createBh 之后、事务之外，BH 建成而审计失败就会留下一张没有出处的草稿。
 * 钩子在 create 审计之后执行，抛错即整单回滚。
 */
export interface CreateBhHooks {
  inTx?: (tx: AnyDb, doc: BhRow) => Promise<void>;
}

export async function createBh(user: SessionUser, input: unknown, dbArg?: AnyDb, hooks?: CreateBhHooks): Promise<BhRow> {
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
    await hooks?.inTx?.(tx, doc);
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

/** D62：受限用户 = 非 admin 且登记了 channel 范围（与 core/data-scope 同口径；未加载 = 不限） */
export type BhListUser = ScopeUser & { id: number };

/**
 * 备货申请列表。
 * D62 渠道范围：BH 单没有渠道列，受限 ops 的「本渠道」= 制单人与本人共享至少一个 channel 范围
 * （user_data_scopes 交集），加上本人制单；admin / 未登记范围的用户不裁剪。
 */
export async function listBhs(
  q: string,
  opts: { status?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
  user?: BhListUser,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(or(sql`${bhDocs.docNo} ILIKE ${"%" + q + "%"}`, skuLineMatch("bh_lines", "bh_id", bhDocs.id, q)));
  if (opts.status) conds.push(eq(bhDocs.status, opts.status as DocStatus));
  if (user && !user.roles.includes("admin") && user.channelScope != null) {
    const allowed = [...new Set(user.channelScope)];
    conds.push(
      or(
        eq(bhDocs.createdBy, user.id),
        exists(
          db
            .select({ one: sql`1` })
            .from(userDataScopes)
            .where(
              and(
                eq(userDataScopes.userId, bhDocs.createdBy),
                eq(userDataScopes.scopeKind, "channel"),
                inArray(userDataScopes.targetId, allowed),
              ),
            ),
        ),
      ),
    );
  }
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

/** 撤回：待审批 → 草稿。仅制单人本人（管理员豁免）；不写审批轨迹、不占审批轮次。 */
export async function withdrawBH(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = withdrawDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const r = await withdrawDoc(tx, {
        docType: "bh",
        table: bhDocs,
        docId: id,
        user: { id: user.id, roles: user.roles },
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, { userId: user.id, entity: "bh", entityId: id, action: "withdraw" });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

/**
 * 手工状态流转：完成 / 短关 / 作废 / 重开。
 * 此前 bh 没有任何到达「已完成」的路径，短关也全仓未实现——
 * 少送尾数的单据会永久卡在「执行中」。这里只补人工收口，不做自动完成。
 */
export async function transitionBH(
  user: SessionUser,
  id: number,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ status: string; idempotent: boolean }> {
  const v = transitionDocSchema.parse(input);
  if (v.action !== "void" && v.action !== "reopen") requireAnyRole(user, "pmc", "ops");
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const r = await transitionDoc(tx, {
        docType: "bh",
        table: bhDocs,
        docId: id,
        user: { id: user.id, roles: user.roles },
        action: v.action,
        reason: v.reason,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "bh", entityId: id, action: v.action,
        after: { status: r.status, reason: v.reason ?? null },
      });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}
