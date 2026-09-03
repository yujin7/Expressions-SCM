/**
 * D60 调拨费用（transfer_fees，单据粒度）——登记 / 红字作废 / 列表。
 *
 * - 只允许**已审批/执行中/已完成**的调拨单（subtype=transfer）登记费用：草稿/待审批单尚无成立的实物移动，
 *   作废/关闭单不再产生费用。
 * - 纠错一律红字：作废 = 插入 amount 为负的新行（reversal_of_id 指向原行，一行只能冲一次，DB 约束钉住），
 *   原行不改不删。
 * - 写路径 service 内 writeAudit 与写入同事务；写守卫 getFreshSessionUser + requireRole(warehouse/finance)。
 * - 录费时按 rules/transfer-cost 给出偏差提醒（warning）：**提醒不阻断**（D60），提醒内容随审计 after 落库。
 * - 金额 scale 2；键 amount/unitFee 已在 SENSITIVE_FIELDS，API 出口 maskSensitive 按角色剥离。
 * 观察口径：费用只做统计维度，不进库存成本、不参与过账。
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dCmp, dMoney, dNeg } from "@/server/core/decimal";
import { requireRole, type SessionUser } from "@/server/core/dto";
import { getNumParam } from "@/server/core/params";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { deviation, type DeviationResult, laneBaseline, unitFee } from "@/server/rules/transfer-cost";
import { ApiError } from "@/server/modules/master/common";
import { laneKeyOf, loadTransferDocFacts, shanghaiDate } from "@/server/modules/report/transfer-routes";

export const TRANSFER_FEE_TYPES = ["freight", "handling", "customs", "other"] as const;
export type TransferFeeType = (typeof TRANSFER_FEE_TYPES)[number];
export const TRANSFER_FEE_TYPE_LABELS: Record<TransferFeeType, string> = {
  freight: "运费",
  handling: "装卸/操作费",
  customs: "关税/报关费",
  other: "其他",
};

/** 可登记费用的单据状态（已审批即视为实物移动成立） */
export const FEE_ALLOWED_DOC_STATUSES = ["approved", "in_progress", "completed"] as const;

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字");

export const addTransferFeeSchema = z.object({
  stockDocId: z.number().int().positive({ message: "必须指定调拨单" }),
  feeType: z.enum(TRANSFER_FEE_TYPES, { errorMap: () => ({ message: "费用类型仅限 运费/装卸/关税/其他" }) }),
  amount: decStr.refine((s) => dCmp(s, "0") >= 0, "费用金额不能为负（作废走红字）"),
  currency: z.string().trim().max(8).optional(),
  carrier: z.string().trim().max(100).optional(),
  bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "费用发生日须为 YYYY-MM-DD"),
  note: z.string().trim().max(500).optional(),
});
export type AddTransferFeeInput = z.infer<typeof addTransferFeeSchema>;

export const reverseTransferFeeSchema = z.object({
  reversalOfId: z.number().int().positive(),
  reason: z.string().trim().min(1, "作废原因必填").max(500),
});

/** 写守卫：仓管 / 财务（admin 兜底） */
export async function guardTransferFeeWrite(): Promise<SessionUser> {
  let user: SessionUser;
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    user = await getFreshSessionUser();
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
  try {
    requireRole(user, "warehouse", "finance");
  } catch {
    throw new ApiError(403, "无权限登记调拨费用（需仓管/财务）");
  }
  return user;
}

type FeeRow = typeof schema.transferFees.$inferSelect;

export interface TransferFeeWarning extends DeviationResult {
  laneKey: string;
  docUnitFee: string | null;
  baselineAvgUnitFee: string | null;
}

/** 本单登记后的单位费用 vs 同线路基线（留一法：本单不进基线） */
async function evaluateWarning(db: AnyDb, docId: number): Promise<TransferFeeWarning | null> {
  const [windowDays, thresholdPct] = await Promise.all([
    getNumParam("transfer_cost_window_days", 180, db),
    getNumParam("transfer_cost_deviation_pct", 20, db),
  ]);
  const asOf = shanghaiDate(new Date());
  const facts = await loadTransferDocFacts(db, { statuses: [...FEE_ALLOWED_DOC_STATUSES] });
  const self = facts.find((f) => f.id === docId);
  if (!self) return null;
  const laneKey = laneKeyOf(self.fromWarehouseId, self.toWarehouseId, self.transferType);
  const history = facts
    .filter((f) => f.id !== docId && f.status === "completed" && f.hasFee && laneKeyOf(f.fromWarehouseId, f.toWarehouseId, f.transferType) === laneKey)
    .map((f) => ({ date: f.date, qty: f.qty, feeTotal: f.feeNet }));
  const base = laneBaseline(history, windowDays, asOf);
  const uf = self.hasFee ? unitFee({ feeTotal: self.feeNet, qty: self.qty }) : null;
  const dev = deviation(uf, base, { thresholdPct });
  return { ...dev, laneKey, docUnitFee: uf, baselineAvgUnitFee: base.avgUnitFee };
}

export async function addTransferFee(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ fee: FeeRow; warning: TransferFeeWarning | null }> {
  const v = addTransferFeeSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [doc]: { id: number; docNo: string; subtype: string; status: string }[] = await tx
      .select({ id: schema.stockDocs.id, docNo: schema.stockDocs.docNo, subtype: schema.stockDocs.subtype, status: schema.stockDocs.status })
      .from(schema.stockDocs)
      .where(eq(schema.stockDocs.id, v.stockDocId));
    if (!doc) throw new ApiError(404, "调拨单不存在");
    if (doc.subtype !== "transfer") throw new ApiError(400, `仅调拨单可登记费用：${doc.docNo} 为 ${doc.subtype}`);
    if (!(FEE_ALLOWED_DOC_STATUSES as readonly string[]).includes(doc.status)) {
      throw new ApiError(409, `仅已审批/已完成的调拨单可登记费用，当前状态: ${doc.status}`);
    }
    const [fee]: FeeRow[] = await tx
      .insert(schema.transferFees)
      .values({
        stockDocId: doc.id,
        feeType: v.feeType,
        amount: dMoney(v.amount),
        currency: v.currency || "CNY",
        carrier: v.carrier || null,
        bizDate: v.bizDate,
        source: "manual",
        note: v.note || null,
        createdBy: user.id,
      })
      .returning();
    const warning = await evaluateWarning(tx, doc.id);
    await writeAudit(tx, {
      userId: user.id,
      entity: "transfer_fee",
      entityId: fee.id,
      action: "create",
      after: {
        stockDocId: doc.id,
        docNo: doc.docNo,
        feeType: fee.feeType,
        amount: fee.amount,
        bizDate: fee.bizDate,
        warning: warning && warning.level !== "ok"
          ? { level: warning.level, pctDev: warning.pctDev, samples: warning.samples, reason: warning.reason }
          : null,
      },
    });
    return { fee, warning };
  });
}

export async function reverseTransferFee(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<FeeRow> {
  const v = reverseTransferFeeSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [orig]: FeeRow[] = await tx.select().from(schema.transferFees).where(eq(schema.transferFees.id, v.reversalOfId));
    if (!orig) throw new ApiError(404, "费用记录不存在");
    if (orig.reversalOfId != null) throw new ApiError(400, "红字行不可再作废（无套娃）");
    const dup: { id: number }[] = await tx
      .select({ id: schema.transferFees.id })
      .from(schema.transferFees)
      .where(eq(schema.transferFees.reversalOfId, orig.id))
      .limit(1);
    if (dup.length > 0) throw new ApiError(409, `该费用已作废（红字 #${dup[0].id}）`);
    if (dCmp(orig.amount, 0) === 0) throw new ApiError(400, "零额费用无需作废");
    const [rev]: FeeRow[] = await tx
      .insert(schema.transferFees)
      .values({
        stockDocId: orig.stockDocId,
        feeType: orig.feeType,
        amount: dNeg(orig.amount, 2),
        currency: orig.currency,
        carrier: orig.carrier,
        bizDate: shanghaiDate(new Date()),
        source: "manual",
        note: v.reason,
        reversalOfId: orig.id,
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "transfer_fee",
      entityId: rev.id,
      action: "reverse",
      before: { id: orig.id, amount: orig.amount, feeType: orig.feeType },
      after: { reversalOfId: orig.id, amount: rev.amount, reason: v.reason },
    });
    return rev;
  });
}

export interface ListTransferFeesQuery {
  q?: string;
  stockDocId?: number;
  feeType?: string;
  fromWarehouseId?: number;
  toWarehouseId?: number;
  transferType?: string;
  dateFrom?: string;
  dateTo?: string;
  /** 默认含红字与被冲行；"active" 只列未作废的原行 */
  view?: "all" | "active";
  page?: number;
  pageSize?: number;
}

export interface TransferFeeListRow {
  id: number;
  stockDocId: number;
  docNo: string;
  docStatus: string;
  transferType: string | null;
  fromWarehouseId: number | null;
  toWarehouseId: number | null;
  fromWarehouse: string | null;
  toWarehouse: string | null;
  feeType: string;
  feeTypeLabel: string;
  /** scale 2（SENSITIVE 键） */
  amount: string;
  currency: string;
  carrier: string | null;
  bizDate: string;
  source: string;
  note: string | null;
  reversalOfId: number | null;
  /** 原行是否已被红字作废 */
  reversed: boolean;
  createdBy: number;
  createdByName: string | null;
  createdAt: Date;
}

export async function listTransferFees(
  query: ListTransferFeesQuery,
  dbArg?: AnyDb,
): Promise<{ rows: TransferFeeListRow[]; total: number }> {
  const db = await resolveDb(dbArg);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const tf = schema.transferFees;
  const sd = schema.stockDocs;
  const lineAgg = db
    .select({
      stockDocId: schema.stockDocLines.stockDocId,
      fromId: sql<number>`min(${schema.stockDocLines.warehouseId})`.as("tf_from_id"),
      toId: sql<number | null>`min(${schema.stockDocLines.toWarehouseId})`.as("tf_to_id"),
    })
    .from(schema.stockDocLines)
    .groupBy(schema.stockDocLines.stockDocId)
    .as("tf_lines");
  const fromWh = alias(schema.warehouses, "tf_wh_from");
  const toWh = alias(schema.warehouses, "tf_wh_to");
  const rev = alias(schema.transferFees, "tf_rev");

  const conds = [];
  if (query.q) conds.push(sql`(${sd.docNo} ILIKE ${"%" + query.q + "%"} OR coalesce(${tf.carrier}, '') ILIKE ${"%" + query.q + "%"})`);
  if (query.stockDocId) conds.push(eq(tf.stockDocId, query.stockDocId));
  if (query.feeType && (TRANSFER_FEE_TYPES as readonly string[]).includes(query.feeType)) conds.push(eq(tf.feeType, query.feeType));
  if (query.fromWarehouseId) conds.push(eq(lineAgg.fromId, query.fromWarehouseId));
  if (query.toWarehouseId) conds.push(eq(lineAgg.toId, query.toWarehouseId));
  if (query.transferType === "unclassified") conds.push(sql`${sd.transferType} IS NULL`);
  else if (query.transferType) conds.push(eq(sd.transferType, query.transferType));
  if (query.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(query.dateFrom)) conds.push(sql`${tf.bizDate} >= ${query.dateFrom}`);
  if (query.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(query.dateTo)) conds.push(sql`${tf.bizDate} <= ${query.dateTo}`);
  if (query.view === "active") conds.push(sql`${tf.reversalOfId} IS NULL`, sql`${rev.id} IS NULL`);
  const where = conds.length ? and(...conds) : undefined;

  const base = db
    .select({
      id: tf.id,
      stockDocId: tf.stockDocId,
      docNo: sd.docNo,
      docStatus: sd.status,
      transferType: sd.transferType,
      fromWarehouseId: lineAgg.fromId,
      toWarehouseId: lineAgg.toId,
      fromWarehouse: fromWh.name,
      toWarehouse: toWh.name,
      feeType: tf.feeType,
      amount: tf.amount,
      currency: tf.currency,
      carrier: tf.carrier,
      bizDate: tf.bizDate,
      source: tf.source,
      note: tf.note,
      reversalOfId: tf.reversalOfId,
      reversedById: rev.id,
      createdBy: tf.createdBy,
      createdByName: schema.users.name,
      createdAt: tf.createdAt,
    })
    .from(tf)
    .innerJoin(sd, eq(tf.stockDocId, sd.id))
    .leftJoin(lineAgg, eq(lineAgg.stockDocId, sd.id))
    .leftJoin(fromWh, eq(lineAgg.fromId, fromWh.id))
    .leftJoin(toWh, eq(lineAgg.toId, toWh.id))
    .leftJoin(rev, eq(rev.reversalOfId, tf.id))
    .leftJoin(schema.users, eq(tf.createdBy, schema.users.id))
    .where(where);
  const countQ = db
    .select({ total: sql<number>`count(*)::int` })
    .from(tf)
    .innerJoin(sd, eq(tf.stockDocId, sd.id))
    .leftJoin(lineAgg, eq(lineAgg.stockDocId, sd.id))
    .leftJoin(rev, eq(rev.reversalOfId, tf.id))
    .where(where);
  const [rows, [{ total }]]: [Record<string, unknown>[], { total: number }[]] = await Promise.all([
    base.orderBy(desc(tf.bizDate), desc(tf.id)).limit(pageSize).offset((page - 1) * pageSize),
    countQ,
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id as number,
      stockDocId: r.stockDocId as number,
      docNo: r.docNo as string,
      docStatus: r.docStatus as string,
      transferType: (r.transferType as string | null) ?? null,
      fromWarehouseId: (r.fromWarehouseId as number | null) ?? null,
      toWarehouseId: (r.toWarehouseId as number | null) ?? null,
      fromWarehouse: (r.fromWarehouse as string | null) ?? null,
      toWarehouse: (r.toWarehouse as string | null) ?? null,
      feeType: r.feeType as string,
      feeTypeLabel: TRANSFER_FEE_TYPE_LABELS[r.feeType as TransferFeeType] ?? (r.feeType as string),
      amount: dMoney(r.amount as string),
      currency: r.currency as string,
      carrier: (r.carrier as string | null) ?? null,
      bizDate: r.bizDate as string,
      source: r.source as string,
      note: (r.note as string | null) ?? null,
      reversalOfId: (r.reversalOfId as number | null) ?? null,
      reversed: r.reversedById != null,
      createdBy: r.createdBy as number,
      createdByName: (r.createdByName as string | null) ?? null,
      createdAt: r.createdAt as Date,
    })),
  };
}

/** 单据费用净额（供单据详情/抽屉） */
export async function transferFeeNetByDoc(docIds: number[], dbArg?: AnyDb): Promise<Map<number, { amount: string; count: number }>> {
  const out = new Map<number, { amount: string; count: number }>();
  if (docIds.length === 0) return out;
  const db = await resolveDb(dbArg);
  const rows: { stockDocId: number; amount: string | null; count: number }[] = await db
    .select({ stockDocId: schema.transferFees.stockDocId, amount: sql<string | null>`sum(${schema.transferFees.amount})`, count: sql<number>`count(*)::int` })
    .from(schema.transferFees)
    .where(inArray(schema.transferFees.stockDocId, docIds))
    .groupBy(schema.transferFees.stockDocId);
  for (const r of rows) out.set(r.stockDocId, { amount: dMoney(r.amount ?? "0"), count: Number(r.count) });
  return out;
}
