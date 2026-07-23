import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  approvals, jgDocs, jgFeeSegments, pcDocs, skus, suppliers, users, woDocs,
} from "@/db/schema";
import { dDeviationPct, dMoney, dZero } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import { approveDoc } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { nextStatus, TransitionError, type DocStatus } from "@/server/docflow/state";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb, rethrowApproval } from "./common";
import { approveDocSchema, confirmDocSchema, createPcForJgFeeSchema } from "./schemas";

/**
 * 委外加工通知单 JG。审批走 docType "jg"（JG 与 WO 同域=PMC 审批）；
 * ⚠ 生产 seed 目前缺 {jg→pmc} 审批配置（见 common.ts REQUIRED_APPROVAL_CONFIGS），
 * 集成阶段须补，否则 approveJg 报 NO_CONFIG（测试自行种配置不受影响）。
 * 加工费改价唯一通道 = PC(target=jg_fee)：createPcForJgFee → approvePc（po.ts）同事务
 * 更新 feeRateCurrent + 插入新分段。
 */

type JgRow = typeof jgDocs.$inferSelect;
type PcRow = typeof pcDocs.$inferSelect;

// ---------- 提交（generateDocs 产出草稿 JG，制单人/PMC 提交进审批） ----------

export async function submitJg(user: SessionUser, id: number, version: number, dbArg?: AnyDb): Promise<JgRow> {
  const db = await resolveDb(dbArg);
  const [doc]: JgRow[] = await db.select().from(jgDocs).where(eq(jgDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  if (doc.createdBy !== user.id && !user.roles.includes("pmc") && !user.roles.includes("admin")) {
    throw new ApiError(403, "仅制单人/PMC/管理员可提交");
  }
  if (doc.status !== "draft") throw new ApiError(409, `当前状态不可提交: ${doc.status}`);
  const updated: JgRow[] = await db
    .update(jgDocs)
    .set({ status: "pending", version: sql`${jgDocs.version} + 1`, updatedAt: new Date() })
    .where(and(eq(jgDocs.id, id), eq(jgDocs.version, version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${version} 已过期`);
  await writeAudit(db, { userId: user.id, entity: "jg", entityId: id, action: "submit" });
  return updated[0];
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
      const r = await approveDoc(tx, {
        docType: "jg",
        table: jgDocs,
        docId: id,
        approver: { id: user.id, roles: user.roles, isApprover: user.isApprover },
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
  requireAnyRole(user, "purchasing", "pmc");
  const v = confirmDocSchema.parse(input);
  const db = await resolveDb(dbArg);
  const [doc]: JgRow[] = await db.select().from(jgDocs).where(eq(jgDocs.id, id));
  if (!doc) throw new ApiError(404, "单据不存在");
  let target: DocStatus;
  try {
    target = nextStatus(doc.status as DocStatus, "confirm");
  } catch (e) {
    if (e instanceof TransitionError) throw new ApiError(409, `当前状态不可确认: ${doc.status}`);
    throw e;
  }
  const now = new Date();
  const updated: JgRow[] = await db
    .update(jgDocs)
    .set({
      status: target,
      confirmedAt: now,
      confirmedBy: user.id,
      confirmNote: v.note ?? null,
      inProduction: true, // 确认即视为进入生产（W4 收货前的看板口径）
      version: sql`${jgDocs.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(jgDocs.id, id), eq(jgDocs.version, v.version)))
    .returning();
  if (updated.length === 0) throw new ApiError(409, `版本冲突：期望版本 ${v.version} 已过期`);
  await writeAudit(db, {
    userId: user.id, entity: "jg", entityId: id, action: "confirm",
    after: { note: v.note ?? null },
  });
  return updated[0];
}

// ---------- 加工费改价：PC(target=jg_fee) 发起（采购）；审批见 po.ts approvePc ----------

export async function createPcForJgFee(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<PcRow> {
  requireAnyRole(user, "purchasing");
  const v = createPcForJgFeeSchema.parse(input);
  const db = await resolveDb(dbArg);

  const [jg]: JgRow[] = await db.select().from(jgDocs).where(eq(jgDocs.id, v.jgId));
  if (!jg) throw new ApiError(404, `加工通知单不存在: #${v.jgId}`);

  // 已有待审的 jg_fee PC → 不重复发起（一次一单，避免并行改价互踩）
  const [open] = await db
    .select({ docNo: pcDocs.docNo })
    .from(pcDocs)
    .where(and(eq(pcDocs.target, "jg_fee"), eq(pcDocs.jgId, v.jgId), eq(pcDocs.status, "pending")));
  if (open) throw new ApiError(409, `该 JG 已有待审批的加工费变更 ${open.docNo}`);

  const newPrice = dMoney(v.newPrice);
  const oldPrice = jg.feeRateCurrent;
  // 现价=0 属数据异常：偏差比无法计算，按 0 记录并仍走审批复核（与 R1 口径一致）
  const deviationPct = dZero(oldPrice) ? "0" : dDeviationPct(oldPrice, newPrice);

  return db.transaction(async (tx: AnyDb) => {
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
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: user.id, entity: "pc", entityId: pc.id, action: "create",
      after: { docNo: pc.docNo, jgId: v.jgId, oldPrice, newPrice, deviationPct, scope: v.scope },
    });
    return pc;
  });
}

// ---------- 查询 ----------

export async function getJg(id: number, dbArg?: AnyDb) {
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
      qty: jgDocs.qty,
      dueDate: jgDocs.dueDate,
      feeRateCurrent: jgDocs.feeRateCurrent, // 敏感——路由边界 maskSensitive 剥离
      orderType: jgDocs.orderType,
      inProduction: jgDocs.inProduction,
      confirmedAt: jgDocs.confirmedAt,
      confirmNote: jgDocs.confirmNote,
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

  const approvalRows = await db
    .select({
      approverName: users.name,
      action: approvals.action,
      comment: approvals.comment,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .leftJoin(users, eq(approvals.approverId, users.id))
    .where(and(inArray(approvals.docType, ["jg"]), eq(approvals.docId, id)))
    .orderBy(approvals.createdAt, approvals.id);

  return { ...doc, feeSegments: segments, approvals: approvalRows };
}

export async function listJgs(
  q: string,
  opts: { status?: string; woId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (q) conds.push(sql`${jgDocs.docNo} ILIKE ${"%" + q + "%"}`);
  if (opts.status) conds.push(eq(jgDocs.status, opts.status as DocStatus));
  if (opts.woId) conds.push(eq(jgDocs.woId, opts.woId));
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
        qty: jgDocs.qty,
        dueDate: jgDocs.dueDate,
        inProduction: jgDocs.inProduction,
        createdByName: users.name,
        createdAt: jgDocs.createdAt,
      })
      .from(jgDocs)
      .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
      .innerJoin(skus, eq(jgDocs.productSkuId, skus.id))
      .leftJoin(users, eq(jgDocs.createdBy, users.id))
      .where(where)
      .orderBy(desc(jgDocs.createdAt), desc(jgDocs.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(jgDocs).where(where),
  ]);
  return { rows, total };
}
