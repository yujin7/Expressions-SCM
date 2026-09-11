import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { selectedOptionsPredicate, SELECTED_OPTIONS_LIMIT, type SelectedOptionValue } from "@/server/core/selected-options";
import {
   approvalConfigs, jgDocs, jgFeeSegments, pcDocs, skus, suppliers, users, woDocs,
} from "@/db/schema";
import { dDeviationPct, dMoney, dZero } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approvalRoleError, approveDoc, loadApprovalHistory, withdrawDoc } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb, rethrowApproval } from "./common";
import { approveDocSchema, confirmDocSchema, createPcForJgFeeSchema, withdrawDocSchema } from "./schemas";
import { getSupplierCapacitySignal } from "@/server/modules/report/supplier-capacity";
import { skuHeaderMatch } from "@/server/core/doc-search";
import { businessDateSchema } from "@/server/core/business-date-schema";
import { currentWriteActor } from "@/server/core/current-write-actor";

/**
 * 委外加工通知单 JG。审批走 docType "jg"（JG 与 WO 同域=PMC 审批）；
 * 生产 seed 已包含 {jg→pmc}；REQUIRED_APPROVAL_CONFIGS 与架构测试共同防漂移。
 * 加工费改价唯一通道 = PC(target=jg_fee)：createPcForJgFee → approvePc（po.ts）同事务
 * 更新 feeRateCurrent + 插入新分段。
 */

type JgRow = typeof jgDocs.$inferSelect;
type PcRow = typeof pcDocs.$inferSelect;

// ---------- 提交（generateDocs 产出草稿 JG，制单人/PMC 提交进审批） ----------

export async function submitJg(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<JgRow> {
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user);
  const [doc]: JgRow[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, id)).for("update");
  if (!doc) throw new ApiError(404, "单据不存在");
  if (doc.createdBy !== actor.id && !actor.roles.includes("pmc") && !actor.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/PMC/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  const updated: JgRow[] = await tx
    .update(jgDocs)
    .set({ status: "pending", version: sql`${jgDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(jgDocs.id, id), eq(jgDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(tx, { userId: actor.id, entity: "jg", entityId: id, action: "submit" });
  return updated[0];
  });
}

// ---------- 审批 ----------

export async function approveJg(
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
      const r = await approveDoc(tx, {
        docType: "jg",
        table: jgDocs,
        docId: id,
        approver: { id: actor.id, roles: actor.roles, isApprover: actor.isApprover },
        action: v.action,
        comment: v.comment,
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, {
        userId: user.id, entity: "jg", entityId: id, action: v.action,
        after: { comment: v.comment ?? null },
      });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}

// ---------- 加工厂确认（内部代录）：approved → in_progress ----------

export async function confirmJg(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<JgRow> {
  const v = confirmDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user);
  requireAnyRole(actor, "purchasing", "pmc");
  const [doc]: JgRow[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, id)).for("update");
  if (!doc) throw new ApiError(404, "单据不存在");
  let target: DocStatus;
  try {
    target = nextStatus(doc.status as DocStatus, "confirm");
  } catch (e) {
    if (e instanceof TransitionError) throw new ApiError(409, `当前状态不可确认: ${doc.status}`);
    throw e;
  }
  const now = new Date();
  const updated: JgRow[] = await tx
    .update(jgDocs)
    .set({
      status: target,
      confirmedAt: now,
      confirmedBy: actor.id,
      confirmNote: v.note ?? null,
      inProduction: true, // 既有流程确认标记，不是现场开工或实收数量。
      version: sql`${jgDocs.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(jgDocs.id, id), eq(jgDocs.version, v.version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${v.version} 已过期`);
  await writeAudit(tx, {
    userId: actor.id, entity: "jg", entityId: id, action: "confirm",
    after: { note: v.note ?? null },
  });
  return updated[0];
  });
}

// ---------- 加工费改价：PC(target=jg_fee) 发起（采购）；审批见 po.ts approvePc ----------

export async function createPcForJgFee(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<PcRow> {
  const v = createPcForJgFeeSchema.parse(input);
  const db = await resolveDb(dbArg);

  return db.transaction(async (tx: AnyDb) => {
  const actor = await currentWriteActor(tx, user);
  requireAnyRole(actor, "purchasing");
  // The JG is the shared serialization point for creation and fee approval.
  // Hold it through pending-check, price snapshot, numbering and audit commit.
  const [jg]: JgRow[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, v.jgId)).for("update");
  if (!jg) throw new ApiError(404, `加工通知单不存在: #${v.jgId}`);

  // 已有待审的 jg_fee PC → 不重复发起（一次一单，避免并行改价互踩）
  const [open] = await tx
    .select({ docNo: pcDocs.docNo })
    .from(pcDocs)
    .where(and(eq(pcDocs.target, "jg_fee"), eq(pcDocs.jgId, v.jgId), eq(pcDocs.status, "pending")));
  if (open) throw new ApiError(409, `该 JG 已有待审批的加工费变更 ${open.docNo}`);

  const newPrice = dMoney(v.newPrice);
  const oldPrice = jg.feeRateCurrent;
  // 现价=0 属数据异常：偏差比无法计算，按 0 记录并仍走审批复核（与 R1 口径一致）
  const deviationPct = dZero(oldPrice) ? "0" : dDeviationPct(oldPrice, newPrice);

    const docNo = await nextDocNo(tx, "PC");
    const [pc]: PcRow[] = await tx
      .insert(pcDocs)
      .values({
        docNo,
        status: "pending",
        remark: v.remark ?? null,
        target: "jg_fee",
        jgId: v.jgId,
        oldPrice,
        newPrice,
        deviationPct,
        scope: v.scope,
        createdBy: actor.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: actor.id, entity: "pc", entityId: pc.id, action: "create",
      after: { docNo: pc.docNo, jgId: v.jgId, oldPrice, newPrice, deviationPct, scope: v.scope },
    });
    return pc;
  });
}

// ---------- 查询 ----------

export function jgTaskActions(user: SessionUser, doc: { status: string; createdBy: number | null }, approvalRole: string | null) {
  const admin = user.roles.includes("admin"), pmc = admin || user.roles.includes("pmc");
  const buying = pmc || user.roles.includes("purchasing"), maker = user.id === doc.createdBy;
  const active = ["draft", "pending", "approved", "in_progress"].includes(doc.status);
  const approvalError = approvalRoleError(user, approvalRole);
  const submit = doc.status === "draft" && (maker || pmc);
  const approve = doc.status === "pending" && !maker && !approvalError;
  const withdraw = doc.status === "pending" && (maker || admin);
  const confirm = doc.status === "approved" && buying;
  const reason = !active ? "历史单据只读；计划、交期及执行流程不可继续修改。"
    : doc.status === "pending" ? (maker ? "制单人不可自审；请等待另一位有资格的审批人处理，可撤回本单。"
      : approvalError?.message ?? "请核对单据后审批；加工确认在审批通过后登记。")
    : doc.status === "draft" ? (submit ? "提交后由另一位有资格的审批人审核。" : "请联系制单人、PMC或管理员提交审批。")
    : doc.status === "approved" ? "加工厂确认由采购、PMC或管理员代录；不等于已核实现场开工。"
    : "已登记加工确认；后续收货、质检和入库请沿单据链核对。";
  return { submit, approve, withdraw, confirm, plan: active && pmc, revise: active && buying, reason };
}

export async function getJg(id: number, dbArg?: AnyDb, user?: SessionUser) {
  const db = await resolveDb(dbArg);
  const [doc] = await db
    .select({
      id: jgDocs.id,
      docNo: jgDocs.docNo,
      status: jgDocs.status,
      remark: jgDocs.remark,
      version: jgDocs.version,
      woId: jgDocs.woId,
      woDocNo: woDocs.docNo,
      supplierId: jgDocs.supplierId,
      supplierName: suppliers.name,
      productSkuId: jgDocs.productSkuId,
      productSkuCode: skus.code,
      productSkuName: skus.name,
      productSkuBarcode: skus.barcode,
      baseUom: skus.baseUom,
      qty: jgDocs.qty,
      dueDate: jgDocs.dueDate,
      feeRateCurrent: jgDocs.feeRateCurrent, // 敏感——路由边界 maskSensitive 剥离
      orderType: jgDocs.orderType,
      inProduction: jgDocs.inProduction,
      confirmedAt: jgDocs.confirmedAt,
      confirmNote: jgDocs.confirmNote,
      pkgRequiredDate: jgDocs.pkgRequiredDate,
      pkgSupplierReplyDate: jgDocs.pkgSupplierReplyDate,
      pkgReadyDate: jgDocs.pkgReadyDate,
      pkgRefNos: jgDocs.pkgRefNos,
      urgentFlag: jgDocs.urgentFlag,
      priority: jgDocs.priority,
      isPaused: jgDocs.isPaused,
      revisedDates: jgDocs.revisedDates,
      createdBy: jgDocs.createdBy,
      createdAt: jgDocs.createdAt,
      createdByName: users.name,
    })
    .from(jgDocs)
    .innerJoin(woDocs, eq(jgDocs.woId, woDocs.id))
    .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
    .innerJoin(skus, eq(jgDocs.productSkuId, skus.id))
    .leftJoin(users, eq(jgDocs.createdBy, users.id))
    .where(eq(jgDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");

  // 分段 rate → DTO 键名 feeRate（SENSITIVE_FIELDS 收录的是 feeRate，保证脱敏可剥）
  const segments = (
    await db
      .select({ id: jgFeeSegments.id, rate: jgFeeSegments.rate, effectiveFrom: jgFeeSegments.effectiveFrom })
      .from(jgFeeSegments)
      .where(eq(jgFeeSegments.jgId, id))
      .orderBy(asc(jgFeeSegments.effectiveFrom), asc(jgFeeSegments.id))
  ).map((s) => ({ id: s.id, feeRate: s.rate, effectiveFrom: s.effectiveFrom }));

  const approvalRows = await loadApprovalHistory(db, "jg", id);

  const capacity = await getSupplierCapacitySignal({
    supplierId: doc.supplierId,
    baseUom: doc.baseUom,
    dueDate: doc.dueDate,
  }, db);

  const [config] = user && doc.status === "pending"
    ? await db.select({ role: approvalConfigs.approverRole }).from(approvalConfigs).where(eq(approvalConfigs.docType, "jg")) : [];
  return { ...doc, feeSegments: segments, approvals: approvalRows, capacity,
    ...(user ? { actions: jgTaskActions(user, doc, config?.role ?? null) } : {}) };
}

export async function listJgs(
  q: string,
  opts: { status?: string; woId?: number; page: number; pageSize: number; receiptEligible?: boolean; selectedValues?: SelectedOptionValue[] },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(or(sql`${jgDocs.docNo} ILIKE ${"%" + q + "%"}`, skuHeaderMatch(jgDocs.productSkuId, q)));
  if (opts.status) conds.push(eq(jgDocs.status, opts.status as DocStatus));
  if (opts.woId) conds.push(eq(jgDocs.woId, opts.woId));
  if (opts.receiptEligible) conds.push(inArray(jgDocs.status, ["approved", "in_progress"]));
  const selected = selectedOptionsPredicate(opts.selectedValues, { id: jgDocs.id, text: [jgDocs.docNo] });
  if (selected) conds.push(selected);
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: jgDocs.id,
        docNo: jgDocs.docNo,
        status: jgDocs.status,
        woId: jgDocs.woId,
        supplierName: suppliers.name,
        productSkuCode: skus.code,
        productSkuName: skus.name,
        baseUom: skus.baseUom,
        qty: jgDocs.qty,
        dueDate: jgDocs.dueDate,
        inProduction: jgDocs.inProduction,
        urgentFlag: jgDocs.urgentFlag,
        isPaused: jgDocs.isPaused,
        createdByName: users.name,
        createdAt: jgDocs.createdAt,
      })
      .from(jgDocs)
      .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
      .innerJoin(skus, eq(jgDocs.productSkuId, skus.id))
      .leftJoin(users, eq(jgDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(jgDocs.createdAt), desc(jgDocs.id))
      .limit(opts.selectedValues === undefined ? opts.pageSize : SELECTED_OPTIONS_LIMIT)
      .offset(opts.selectedValues === undefined ? (opts.page - 1) * opts.pageSize : 0),
    db.select({ total: sql<number>`count(*)::int` }).from(jgDocs).where(where),
  ]);
  return { rows, total };
}

// ---------- 包材齐套 / 计划属性（04 §2 W3 增列批；合规审计补落的执行面） ----------

import { z } from "zod";

const dateStrOpt = z.preprocess(
  (v) => (v === "" ? null : v),
  businessDateSchema.nullable().optional(),
);

export const jgPlanSchema = z.object({
  pkgRequiredDate: dateStrOpt,
  pkgSupplierReplyDate: dateStrOpt,
  pkgReadyDate: dateStrOpt,
  pkgRefNos: z.array(z.string().trim().min(1)).max(20).optional(),
  urgentFlag: z.boolean().optional(),
  priority: z.enum(["高", "中", "低"]).nullable().optional(),
  isPaused: z.boolean().optional(),
});

/** 计划属性维护（PMC/admin）：包材齐套三日期、关联单号、紧急/优先级/暂停 */
export async function updateJgPlan(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<JgRow> {
  const v = jgPlanSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "pmc");
    const [doc]: JgRow[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, id)).for("update");
    if (!doc) throw new ApiError(404, "加工通知单不存在");
    if (["void", "closed", "completed"].includes(doc.status)) throw new ApiError(409, "终态单据不可维护计划属性");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["pkgRequiredDate", "pkgSupplierReplyDate", "pkgReadyDate", "urgentFlag", "priority", "isPaused"] as const) {
      if (v[k] !== undefined) patch[k] = v[k];
    }
    if (v.pkgRefNos !== undefined) patch.pkgRefNos = v.pkgRefNos;
    const [updated]: JgRow[] = await tx.update(jgDocs).set(patch).where(eq(jgDocs.id, id)).returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "jg",
      entityId: id,
      action: "plan_update",
      before: {
        pkgRequiredDate: doc.pkgRequiredDate, pkgSupplierReplyDate: doc.pkgSupplierReplyDate,
        pkgReadyDate: doc.pkgReadyDate, urgentFlag: doc.urgentFlag, priority: doc.priority, isPaused: doc.isPaused,
      },
      after: v,
  });
  return updated;
  });
}

export const jgReviseDueSchema = z.object({
  newDate: businessDateSchema,
  reason: z.string().trim().min(1, "改期原因必填").max(200),
});

/** 交期修改（留痕入 revisedDates 历史，禁止直接改 dueDate 旁路） */
export async function reviseJgDueDate(user: SessionUser, id: number, input: unknown, dbArg?: AnyDb): Promise<JgRow> {
  const v = jgReviseDueSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "pmc", "purchasing");
    const [doc]: JgRow[] = await tx.select().from(jgDocs).where(eq(jgDocs.id, id)).for("update");
    if (!doc) throw new ApiError(404, "加工通知单不存在");
    if (["void", "closed", "completed"].includes(doc.status)) throw new ApiError(409, "终态单据不可改期");
    const history = Array.isArray(doc.revisedDates) ? (doc.revisedDates as unknown[]) : [];
    if (history.length >= 20) throw new ApiError(409, "改期次数已达上限（20），请走线下评审");
    const entry = { from: doc.dueDate, to: v.newDate, reason: v.reason, by: actor.name, at: new Date().toISOString() };
    const [updated]: JgRow[] = await tx
      .update(jgDocs)
      .set({ dueDate: v.newDate, revisedDates: [...history, entry], updatedAt: new Date() })
      .where(eq(jgDocs.id, id))
      .returning();
    await writeAudit(tx, { userId: actor.id, entity: "jg", entityId: id, action: "revise_due", before: { dueDate: doc.dueDate }, after: entry });
    return updated;
  });
}

/** 撤回：待审批 → 草稿。仅制单人本人（管理员豁免）；不写审批轨迹、不占审批轮次。 */
export async function withdrawJG(
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
      const r = await withdrawDoc(tx, {
        docType: "jg",
        table: jgDocs,
        docId: id,
        user: { id: actor.id, roles: actor.roles },
        expectedVersion: v.version,
      });
      if (r.idempotent) return r;
      await writeAudit(tx, { userId: user.id, entity: "jg", entityId: id, action: "withdraw" });
      return r;
    });
  } catch (e) {
    rethrowApproval(e);
  }
}
