import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { approvalConfigs, bhDocs, bhLines, skus, users, woDocs } from "@/db/schema";
import { bhReadScope, type BhReadUser } from "@/server/core/bh-read-scope";
import { currentWriteActor } from "@/server/core/current-write-actor";
import { loadUserScopes } from "@/server/core/data-scope";
import { dQty } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approvalRoleError, approveDoc, loadApprovalHistory, withdrawDoc } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb, rethrowApproval } from "./common";
import { approveDocSchema, createBhSchema, transitionDocSchema, updateBhSchema, withdrawDocSchema } from "./schemas";
import { createdWithinShanghaiDays, skuLineMatch } from "@/server/core/doc-search";
import { transitionDoc } from "@/server/docflow/transition";
import { getBhOrigin } from "./bh-origin";
import { SELECTED_OPTIONS_LIMIT, selectedOptionsPredicate, type SelectedOptionValue } from "@/server/core/selected-options";

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
  return createBhWithAuthority(user, input, ["ops"], dbArg, hooks);
}

/** Internal source workflows retain their own authority; never fabricate an ops role. */
export async function createDerivedBh(
  user: SessionUser, source: "npd" | "replenish" | "sop", input: unknown,
  dbArg: AnyDb, hooks: Required<CreateBhHooks>,
): Promise<BhRow> {
  return createBhWithAuthority(user, input, source === "npd" ? ["pmc", "ops"] : ["pmc"], dbArg, hooks);
}

async function createBhWithAuthority(
  user: SessionUser, input: unknown, roles: string[], dbArg?: AnyDb, hooks?: CreateBhHooks,
): Promise<BhRow> {
  const v = createBhSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, ...roles);
    const skuIds = [...new Set(v.lines.map((l) => l.skuId))].sort((a, b) => a - b);
    const skuRows: { id: number; active: boolean }[] = await tx
      .select({ id: skus.id, active: skus.active }).from(skus)
      .where(inArray(skus.id, skuIds)).orderBy(skus.id).for("share");
    const activeSku = new Set(skuRows.filter((s) => s.active).map((s) => s.id));
    for (const sid of skuIds) {
      if (!activeSku.has(sid)) throw new ApiError(400, `SKU 不存在或已停用: #${sid}`);
    }
    const docNo = await nextDocNo(tx, "BH");
    const [doc]: BhRow[] = await tx
      .insert(bhDocs)
      .values({
        docNo,
        remark: v.remark ?? null,
        // 集成阶段如需独立列再迁移（诚实标注，勿当正式口径）。
        orderType: v.orderType ?? null,
        createdBy: actor.id,
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
      userId: actor.id, entity: "bh", entityId: doc.id, action: "create",
      after: { docNo: doc.docNo, lineCount: v.lines.length, orderType: v.orderType ?? null },
    });
    await hooks?.inTx?.(tx, doc);
    return doc;
  });
}

/** Shared source lock also serializes draft edits, closure and automatic line generation. */
async function lockWritableBh(tx: AnyDb, actor: SessionUser, id: number): Promise<BhRow> {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new ApiError(400, "备货申请编号无效");
  const scopes = await loadUserScopes(tx, actor.id);
  const [doc]: BhRow[] = await tx.select().from(bhDocs)
    .where(and(eq(bhDocs.id, id), bhReadScope(tx, { ...actor, ...scopes }))).for("update");
  if (!doc) throw new ApiError(404, "单据不存在或不在当前可读范围");
  return doc;
}

export async function submitBh(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<BhRow> {
  if (!Number.isSafeInteger(version) || version <= 0 || version > 2147483647) throw new ApiError(400, "备货申请版本无效");
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    const doc = await lockWritableBh(tx, actor, id);
    if (doc.createdBy !== actor.id && !actor.roles.includes("admin")) {
      throw new ApiError(403, "仅制单人或管理员可提交");
    }
    let target: DocStatus;
    try {
      target = nextStatus(doc.status as DocStatus, "submit");
    } catch (e) {
      if (e instanceof TransitionError) throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
      throw e;
    }
    const updated: BhRow[] = await tx
      .update(bhDocs)
      .set({ status: target, version: sql`${bhDocs.version} + 1`, updatedAt: new Date() })
      .where(and(eq(bhDocs.id, id), eq(bhDocs.version, version), eq(bhDocs.status, "draft")))
      .returning();
    if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
    await writeAudit(tx, { userId: actor.id, entity: "bh", entityId: id, action: "submit" });
    return updated[0];
  });
}

export async function updateBh(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<BhRow> {
  const v = updateBhSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    const doc = await lockWritableBh(tx, actor, id);
    if (doc.createdBy !== actor.id && !actor.roles.includes("admin")) throw new ApiError(403, "仅制单人或管理员可修改草稿");
    if (doc.status !== "draft") throw new ApiError(409, "仅草稿可修改，请先撤回或由审批人驳回");
    if (doc.version !== v.version) throw new ApiError(409, "版本已更新，请重新加载后核对，勿覆盖他人修改");
    const [downstream] = await tx.select({ id: woDocs.id }).from(woDocs).where(eq(woDocs.bhId, id)).limit(1);
    if (downstream) throw new ApiError(409, "已有关联工单，不可改写需求来源，请核对下游单据");
    const beforeLines: (typeof bhLines.$inferSelect)[] = await tx.select().from(bhLines).where(eq(bhLines.bhId, id)).orderBy(bhLines.id);
    const sourceSkuLocked = (await getBhOrigin(tx, id, doc.docNo)).fromSuggestion;
    const identity = (lines: { skuId: number }[]) => lines.map(l => l.skuId).sort((a, b) => a - b).join(",");
    if (sourceSkuLocked && identity(beforeLines) !== identity(v.lines)) throw new ApiError(409, "来源SKU已绑定计划或新品首单，不可增删/替换；请在来源流程重新发起需求");
    const skuIds = [...new Set(v.lines.map(l => l.skuId))];
    const available: { id: number }[] = await tx.select({ id: skus.id }).from(skus).where(and(inArray(skus.id, skuIds), eq(skus.active, true))).orderBy(skus.id).for("share");
    if (available.length !== skuIds.length) throw new ApiError(400, "明细存在不存在或已停用的SKU，请重新选择");
    const [updated]: BhRow[] = await tx.update(bhDocs).set({
      remark: v.remark ?? null, orderType: v.orderType ?? null, purpose: null,
      version: sql`${bhDocs.version} + 1`, updatedAt: new Date(),
    }).where(and(eq(bhDocs.id, id), eq(bhDocs.version, v.version), eq(bhDocs.status, "draft"))).returning();
    if (!updated) throw new ApiError(409, "版本冲突，请重新加载");
    await tx.delete(bhLines).where(eq(bhLines.bhId, id));
    const lines = v.lines.map(l => ({ bhId: id, skuId: l.skuId, qty: dQty(l.qty), expectDate: l.expectDate ?? null }));
    await tx.insert(bhLines).values(lines);
    await writeAudit(tx, { userId: actor.id, entity: "bh", entityId: id, action: "update_draft",
      before: { version: doc.version, remark: doc.remark, orderType: doc.orderType ?? doc.purpose, lines: beforeLines },
      after: { reason: v.reason, version: updated.version, remark: updated.remark, orderType: updated.orderType, sourceSkuLocked, lines } });
    return updated;
  });
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
      const actor = await currentWriteActor(tx, user);
      await lockWritableBh(tx, actor, id);
      const r = await approveDoc(tx, {
        docType: "bh",
        table: bhDocs,
        docId: id,
        approver: actor,
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: actor.id, entity: "bh", entityId: id, action: v.action,
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

export async function getBh(id: number, dbArg?: AnyDb, user?: BhReadUser & { isApprover?: boolean }) {
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
    .where(and(eq(bhDocs.id, id), bhReadScope(db, user)));
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

  const origin = await getBhOrigin(db, id, doc.docNo);
  const sourceSkuLocked = origin.fromSuggestion;
  let actions;
  if (user) {
    const [cfg] = await db.select().from(approvalConfigs).where(eq(approvalConfigs.docType, "bh"));
    const owner = doc.createdBy === user.id || user.roles.includes("admin");
    const roleError = approvalRoleError({ ...user, isApprover: user.isApprover ?? false }, cfg?.approverRole ?? null);
    const approvalReason = doc.createdBy === user.id ? "制单人与审批人必须分离，请由另一位审批人处理" : roleError?.message ?? null;
    const operator = user.roles.some(r => ["admin", "pmc", "ops"].includes(r));
    const [downstream] = doc.status === "draft" && owner
      ? await db.select({ id: woDocs.id }).from(woDocs).where(eq(woDocs.bhId, id)).limit(1) : [];
    const editReason = downstream ? "已有关联工单，不可改写需求来源，请核对下游单据" : null;
    actions = { edit: doc.status === "draft" && owner && !downstream, editReason, submit: doc.status === "draft" && owner,
      void: doc.status === "draft" && owner, withdraw: doc.status === "pending" && owner,
      approve: doc.status === "pending" && !approvalReason, approvalReason,
      complete: doc.status === "in_progress" && operator,
      shortClose: ["approved", "in_progress"].includes(doc.status) && operator };
  }
  return { ...doc, lines, approvals: approvalRows, sourceSkuLocked, origin, ...(actions ? { actions } : {}) };
}

/** D62：受限用户 = 非 admin 且登记了 channel 范围（与 core/data-scope 同口径；未加载 = 不限） */
export type BhListUser = BhReadUser;

/**
 * 备货申请列表。
 * D62 渠道范围：BH 单没有渠道列，受限 ops 的「本渠道」= 制单人与本人共享至少一个 channel 范围
 * （user_data_scopes 交集），加上本人制单；admin / 未登记范围的用户不裁剪。
 */
export async function listBhs(
  q: string,
  opts: { status?: string; from?: string; to?: string; page: number; pageSize: number; selectedValues?: SelectedOptionValue[] },
  dbArg?: AnyDb,
  user?: BhListUser,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(or(sql`${bhDocs.docNo} ILIKE ${"%" + q + "%"}`, skuLineMatch("bh_lines", "bh_id", bhDocs.id, q)));
  if (opts.status) conds.push(eq(bhDocs.status, opts.status as DocStatus));
  // 制单时间窗（上海业务日，含首尾）：全链漏斗「计划」级按同一口径回链到本列表
  conds.push(...createdWithinShanghaiDays(bhDocs.createdAt, opts.from, opts.to));
  const scope = bhReadScope(db, user);
  if (scope) conds.push(scope);
  const selected = selectedOptionsPredicate(opts.selectedValues, { id: bhDocs.id, text: [bhDocs.docNo] });
  if (selected) conds.push(selected);
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
      .limit(opts.selectedValues === undefined ? opts.pageSize : SELECTED_OPTIONS_LIMIT)
      .offset(opts.selectedValues === undefined ? (opts.page - 1) * opts.pageSize : 0),
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
      const actor = await currentWriteActor(tx, user);
      await lockWritableBh(tx, actor, id);
      const r = await withdrawDoc(tx, {
        docType: "bh",
        table: bhDocs,
        docId: id,
        user: actor,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, { userId: actor.id, entity: "bh", entityId: id, action: "withdraw" });
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
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const actor = await currentWriteActor(tx, user);
      if (v.action !== "void" && v.action !== "reopen") requireAnyRole(actor, "pmc", "ops");
      await lockWritableBh(tx, actor, id);
      const r = await transitionDoc(tx, {
        docType: "bh",
        table: bhDocs,
        docId: id,
        user: actor,
        action: v.action,
        reason: v.reason,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: actor.id, entity: "bh", entityId: id, action: v.action,
        after: { status: r.status, reason: v.reason ?? null },
      });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}
