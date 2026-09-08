import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync, schema } from "@/db";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { shanghaiDay } from "@/server/core/business-day";
import { setSupplierPaymentTerm } from "./supplier";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- services accept the production DB or an isolated PGlite transaction
type AnyDb = any;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
  .refine(value => !value.startsWith("0000-") && shanghaiDay(value) === value, "日期必须是有效日历日期");
const supplierStatus = z.enum(["pending", "qualified", "paused", "blacklisted"]);
const caseKinds = ["admission", "corrective", "payment_term"] as const;

export interface SupplierTermSnapshot {
  paymentTermType: string | null;
  creditDays: number | null;
  paymentTermEffectiveFrom: string | null;
  paymentTerm: string | null;
}
const agreementSchema = z.object({
  creditDays: z.number().int().min(1).max(180),
  effectiveFrom: dateString,
  paymentTerm: z.string().trim().min(1).max(500),
  evidenceRef: z.string().trim().min(5, "请提供协议编号或受控文件位置").max(500),
}).strict();
export type SupplierTermAgreement = z.infer<typeof agreementSchema>;
function termSnapshot(row: Partial<SupplierTermSnapshot>): SupplierTermSnapshot {
  return { paymentTermType: row.paymentTermType ?? null, creditDays: row.creditDays ?? null,
    paymentTermEffectiveFrom: row.paymentTermEffectiveFrom ?? null, paymentTerm: row.paymentTerm ?? null };
}
function sameTerms(a: Partial<SupplierTermSnapshot>, b: Partial<SupplierTermSnapshot>): boolean {
  return JSON.stringify(termSnapshot(a)) === JSON.stringify(termSnapshot(b));
}
function sameAgreement(a: SupplierTermAgreement | null, b: SupplierTermAgreement | undefined): boolean {
  return a == null ? b == null : b != null && a.creditDays === b.creditDays && a.effectiveFrom === b.effectiveFrom
    && a.paymentTerm === b.paymentTerm && a.evidenceRef === b.evidenceRef;
}

const openCaseSchema = z.object({
  supplierId: z.number().int().positive(),
  kind: z.enum(caseKinds),
  priority: z.enum(["normal", "high", "critical"]).default("normal"),
  reason: z.string().trim().min(5, "请填写至少 5 个字的准入依据或整改原因").max(500),
  dueDate: dateString,
  pauseNewOrders: z.boolean().optional().default(false),
  idempotencyKey: z.string().uuid(),
  ownerId: z.number().int().positive().optional(),
  targetCreditDays: z.number().int().min(45).max(60).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "payment_term" && (value.targetCreditDays == null || value.pauseNewOrders)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "账期谈判须明确45–60天目标，且不能暂停新单" });
  }
  if (value.kind !== "payment_term" && value.targetCreditDays != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "准入/整改不能设置谈判账期目标" });
  }
});

const closeCaseSchema = z.object({
  outcome: z.enum(["approved", "rejected", "resolved", "failed"]),
  finalStatus: supplierStatus.optional(),
  closureNote: z.string().trim().min(5, "请填写至少 5 个字的完成证据").max(1000),
  expectedVersion: z.number().int().positive().optional(),
  agreement: agreementSchema.optional(),
});

const followUpSchema = z.object({
  expectedVersion: z.number().int().positive(),
  note: z.string().trim().min(5, "请记录至少5个字的跟进依据").max(1000),
  ownerId: z.number().int().positive().optional(),
  dueDate: dateString.optional(),
  confirmCurrentTerm: z.boolean().optional().default(false),
  confirmedTerm: z.object({ paymentTermType: z.string().nullable(), creditDays: z.number().int().nullable(),
    paymentTermEffectiveFrom: dateString.nullable(), paymentTerm: z.string().nullable() }).strict().optional(),
});

async function requireActiveBuyer(db: AnyDb, id: number) {
  const [owner] = await db.select({ id: schema.users.id, active: schema.users.active, roles: schema.users.roles })
    .from(schema.users).where(eq(schema.users.id, id)).for("share");
  if (!owner?.active || !owner.roles.some((role: string) => ["admin", "purchasing"].includes(role))) {
    throw new ApiError(400, "责任人必须是有效的采购或管理员账号");
  }
}

/** All lifecycle writes lock supplier before case, matching open and master edits. */
async function lockCase(db: AnyDb, id: number) {
  const [identity] = await db.select({ supplierId: schema.supplierLifecycleCases.supplierId })
    .from(schema.supplierLifecycleCases).where(eq(schema.supplierLifecycleCases.id, id));
  if (!identity) throw new ApiError(404, "供应商工作项不存在");
  const [supplier] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, identity.supplierId)).for("update");
  if (!supplier) throw new ApiError(404, "供应商不存在");
  const [current] = await db.select().from(schema.supplierLifecycleCases).where(eq(schema.supplierLifecycleCases.id, id)).for("update");
  if (!current) throw new ApiError(404, "供应商工作项不存在");
  return { current, supplier };
}

export interface SupplierLifecycleRow {
  id: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  supplierStatus: string;
  kind: typeof caseKinds[number];
  status: "open" | "closed";
  priority: "normal" | "high" | "critical";
  reason: string;
  dueDate: string;
  overdue: boolean;
  ownerId: number;
  ownerName: string;
  pauseNewOrders: boolean;
  supplierStatusBefore: string;
  supplierStatusAfter: string;
  outcome: string | null;
  closureNote: string | null;
  createdBy: number;
  createdAt: Date;
  closedBy: number | null;
  closedAt: Date | null;
  targetCreditDays: number | null;
  termBaseline: SupplierTermSnapshot | null;
  termAgreement: SupplierTermAgreement | null;
  termCurrent: SupplierTermSnapshot;
  termChanged: boolean;
  progressNote: string | null;
  version: number;
}

async function hydrateRows(db: AnyDb, rawRows: Array<Record<string, unknown>>): Promise<SupplierLifecycleRow[]> {
  const userIds = [
    ...new Set(
      rawRows
        .flatMap((row) => [Number(row.ownerId), Number(row.createdBy), Number(row.closedBy)])
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  const userRows: Array<{ id: number; name: string }> = userIds.length
    ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const userNames = new Map(userRows.map((row) => [row.id, row.name]));
  const today = todayShanghai();
  return rawRows.map((row) => ({
    ...(row as unknown as Omit<SupplierLifecycleRow, "ownerName" | "overdue">),
    ownerName: userNames.get(Number(row.ownerId)) ?? `用户 #${row.ownerId}`,
    overdue: row.status === "open" && String(row.dueDate) < today,
    termChanged: row.kind === "payment_term" && row.status === "open"
      && !sameTerms((row.termBaseline ?? {}) as SupplierTermSnapshot, row.termCurrent as SupplierTermSnapshot),
  }));
}

export async function listSupplierLifecycleCases(
  query: {
    q?: string;
    page?: number;
    pageSize?: number;
    status?: string;
    kind?: string;
    supplierId?: number;
    caseId?: number;
    ownerId?: number;
    sort?: string;
    order?: string;
  },
  dbArg?: AnyDb,
) {
  z.object({
    kind: z.enum(["", ...caseKinds]).optional(), status: z.enum(["", "open", "closed"]).optional(),
    page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(200).optional(),
    supplierId: z.number().int().positive().optional(), caseId: z.number().int().positive().optional(),
    ownerId: z.number().int().positive().optional(),
    sort: z.enum(["", "supplierCode", "priority", "dueDate", "ownerName", "createdAt"]).optional(),
    order: z.enum(["", "ascend", "descend"]).optional(),
  }).parse(query);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 20));
  const q = (query.q ?? "").trim();
  const scopeConditions = [
    q
      ? or(
          ilike(schema.suppliers.code, `%${q}%`),
          ilike(schema.suppliers.name, `%${q}%`),
          ilike(schema.supplierLifecycleCases.reason, `%${q}%`),
        )
      : undefined,
    query.kind && caseKinds.includes(query.kind as typeof caseKinds[number])
      ? eq(schema.supplierLifecycleCases.kind, query.kind)
      : undefined,
    query.supplierId ? eq(schema.supplierLifecycleCases.supplierId, query.supplierId) : undefined,
    query.caseId ? eq(schema.supplierLifecycleCases.id, query.caseId) : undefined,
    query.ownerId ? eq(schema.supplierLifecycleCases.ownerId, query.ownerId) : undefined,
  ].filter(Boolean);
  const conditions = [
    ...scopeConditions,
    query.status === "open" || query.status === "closed"
      ? eq(schema.supplierLifecycleCases.status, query.status)
      : undefined,
  ].filter(Boolean);
  const where = conditions.length ? and(...conditions) : undefined;
  const priorityOrder = sql`CASE ${schema.supplierLifecycleCases.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END`;
  const sortFields = {
    supplierCode: schema.suppliers.code, priority: priorityOrder, dueDate: schema.supplierLifecycleCases.dueDate,
    ownerName: sql`(SELECT name FROM users WHERE users.id = ${schema.supplierLifecycleCases.ownerId})`,
    createdAt: schema.supplierLifecycleCases.createdAt,
  };
  const selectedSort = sortFields[query.sort as keyof typeof sortFields];
  const orderBy = selectedSort ? [query.order === "descend" ? desc(selectedSort) : asc(selectedSort), desc(schema.supplierLifecycleCases.id)]
    : [priorityOrder, schema.supplierLifecycleCases.dueDate, desc(schema.supplierLifecycleCases.id)];

  const baseSelect = {
    id: schema.supplierLifecycleCases.id,
    supplierId: schema.supplierLifecycleCases.supplierId,
    supplierCode: schema.suppliers.code,
    supplierName: schema.suppliers.name,
    supplierStatus: schema.suppliers.status,
    kind: schema.supplierLifecycleCases.kind,
    status: schema.supplierLifecycleCases.status,
    priority: schema.supplierLifecycleCases.priority,
    reason: schema.supplierLifecycleCases.reason,
    dueDate: schema.supplierLifecycleCases.dueDate,
    ownerId: schema.supplierLifecycleCases.ownerId,
    pauseNewOrders: schema.supplierLifecycleCases.pauseNewOrders,
    supplierStatusBefore: schema.supplierLifecycleCases.supplierStatusBefore,
    supplierStatusAfter: schema.supplierLifecycleCases.supplierStatusAfter,
    outcome: schema.supplierLifecycleCases.outcome,
    closureNote: schema.supplierLifecycleCases.closureNote,
    createdBy: schema.supplierLifecycleCases.createdBy,
    createdAt: schema.supplierLifecycleCases.createdAt,
    closedBy: schema.supplierLifecycleCases.closedBy,
    closedAt: schema.supplierLifecycleCases.closedAt,
    targetCreditDays: schema.supplierLifecycleCases.targetCreditDays,
    termBaseline: schema.supplierLifecycleCases.termBaseline,
    termAgreement: schema.supplierLifecycleCases.termAgreement,
    progressNote: schema.supplierLifecycleCases.progressNote,
    version: schema.supplierLifecycleCases.version,
    termCurrent: {
      paymentTermType: schema.suppliers.paymentTermType,
      creditDays: schema.suppliers.creditDays,
      paymentTermEffectiveFrom: schema.suppliers.paymentTermEffectiveFrom,
      paymentTerm: schema.suppliers.paymentTerm,
    },
  };

  const [rawRows, totalRows] = await Promise.all([
    db
      .select(baseSelect)
      .from(schema.supplierLifecycleCases)
      .innerJoin(schema.suppliers, eq(schema.supplierLifecycleCases.supplierId, schema.suppliers.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.supplierLifecycleCases)
      .innerJoin(schema.suppliers, eq(schema.supplierLifecycleCases.supplierId, schema.suppliers.id))
      .where(where),
  ]);

  // KPI follows supplier/search/type scope but deliberately ignores the table status filter.
  const [summary] = await db
    .select({
      open: sql<number>`count(*) filter (where ${schema.supplierLifecycleCases.status} = 'open')::int`,
      overdue: sql<number>`count(*) filter (where ${schema.supplierLifecycleCases.status} = 'open' and ${schema.supplierLifecycleCases.dueDate} < ${todayShanghai()})::int`,
      admissions: sql<number>`count(*) filter (where ${schema.supplierLifecycleCases.status} = 'open' and ${schema.supplierLifecycleCases.kind} = 'admission')::int`,
      corrective: sql<number>`count(*) filter (where ${schema.supplierLifecycleCases.status} = 'open' and ${schema.supplierLifecycleCases.kind} = 'corrective')::int`,
      negotiations: sql<number>`count(*) filter (where ${schema.supplierLifecycleCases.status} = 'open' and ${schema.supplierLifecycleCases.kind} = 'payment_term')::int`,
    })
    .from(schema.supplierLifecycleCases)
    .innerJoin(schema.suppliers, eq(schema.supplierLifecycleCases.supplierId, schema.suppliers.id))
    .where(scopeConditions.length ? and(...scopeConditions) : undefined);

  const owners: Array<{ id: number; name: string }> = await db.select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users).where(and(eq(schema.users.active, true), sql`${schema.users.roles} && ARRAY['purchasing','admin']::text[]`))
    .orderBy(schema.users.name, schema.users.id);
  return {
    rows: await hydrateRows(db, rawRows),
    owners,
    total: Number(totalRows[0]?.total ?? 0),
    summary: {
      open: Number(summary?.open ?? 0),
      overdue: Number(summary?.overdue ?? 0),
      admissions: Number(summary?.admissions ?? 0),
      corrective: Number(summary?.corrective ?? 0),
      negotiations: Number(summary?.negotiations ?? 0),
    },
  };
}

/** Case-only history: never return supplier audit snapshots containing bank/contact fields. */
export async function getSupplierLifecycleDetail(caseId: number, beforeAuditId?: number, dbArg?: AnyDb) {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const result = await listSupplierLifecycleCases({ caseId, pageSize: 1 }, db);
  if (!result.rows[0]) throw new ApiError(404, "供应商工作项不存在");
  const events = await db.select({ id: schema.auditLogs.id, at: schema.auditLogs.createdAt,
    actorName: schema.users.name, action: schema.auditLogs.action, before: schema.auditLogs.before, after: schema.auditLogs.after })
    .from(schema.auditLogs).leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
    .where(and(eq(schema.auditLogs.entity, "supplier_lifecycle"), eq(schema.auditLogs.entityId, caseId),
      beforeAuditId ? lt(schema.auditLogs.id, beforeAuditId) : undefined))
    .orderBy(desc(schema.auditLogs.id)).limit(51);
  return { row: result.rows[0], history: events.slice(0, 50), nextCursor: events.length > 50 ? events[49].id as number : null };
}

export async function openSupplierLifecycleCase(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
) {
  requireAnyRole(user, "purchasing");
  const value = openCaseSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());

  return db.transaction(async (tx: AnyDb) => {
    await tx.execute(sql`SELECT id FROM suppliers WHERE id = ${value.supplierId} FOR UPDATE`);
    const [supplier] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, value.supplierId));
    if (!supplier) throw new ApiError(404, "供应商不存在");

    const [replayed] = await tx
      .select()
      .from(schema.supplierLifecycleCases)
      .where(eq(schema.supplierLifecycleCases.idempotencyKey, value.idempotencyKey));
    if (replayed) {
      const sameRequest =
        replayed.supplierId === value.supplierId
        && replayed.kind === value.kind
        && replayed.priority === value.priority
        && replayed.reason === value.reason
        && replayed.dueDate === value.dueDate
        && replayed.pauseNewOrders === value.pauseNewOrders
        && replayed.createdBy === user.id
        && replayed.ownerId === (value.ownerId ?? user.id)
        && replayed.targetCreditDays === (value.targetCreditDays ?? null);
      if (!sameRequest) {
        throw new ApiError(409, "幂等键已绑定不同的供应商工作项请求");
      }
      return replayed;
    }

    if (value.dueDate < todayShanghai()) throw new ApiError(400, "截止日不能早于今天");
    await requireActiveBuyer(tx, value.ownerId ?? user.id);

    const [openCase] = await tx
      .select({ id: schema.supplierLifecycleCases.id })
      .from(schema.supplierLifecycleCases)
      .where(
        and(
          eq(schema.supplierLifecycleCases.supplierId, value.supplierId),
          eq(schema.supplierLifecycleCases.kind, value.kind),
          eq(schema.supplierLifecycleCases.status, "open"),
        ),
      );
    if (openCase) throw new ApiError(409, "该供应商已有同类型未关闭工作项");

    if (value.kind === "admission" && supplier.status !== "pending") {
      throw new ApiError(409, "只有“准入中”供应商可发起准入评审");
    }
    if (value.kind === "corrective" && !["qualified", "paused"].includes(supplier.status)) {
      throw new ApiError(409, "整改仅适用于合格或暂停供应商");
    }
    if (value.kind === "payment_term" && !["qualified", "paused"].includes(supplier.status)) {
      throw new ApiError(409, "账期谈判仅适用于合格或暂停供应商；不改变其准入状态");
    }

    let statusAfter = supplier.status;
    if (value.kind === "corrective" && value.pauseNewOrders && supplier.status === "qualified") {
      statusAfter = "paused";
      const [updatedSupplier] = await tx
        .update(schema.suppliers)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(schema.suppliers.id, supplier.id))
        .returning();
      await writeAudit(tx, {
        userId: user.id,
        entity: "supplier",
        entityId: supplier.id,
        action: "lifecycle_pause",
        before: supplier,
        after: updatedSupplier,
      });
    }

    const [created] = await tx
      .insert(schema.supplierLifecycleCases)
      .values({
        supplierId: value.supplierId,
        kind: value.kind,
        priority: value.priority,
        reason: value.reason,
        dueDate: value.dueDate,
        ownerId: value.ownerId ?? user.id,
        targetCreditDays: value.targetCreditDays ?? null,
        termBaseline: value.kind === "payment_term" ? termSnapshot(supplier) : null,
        pauseNewOrders: value.pauseNewOrders,
        supplierStatusBefore: supplier.status,
        supplierStatusAfter: statusAfter,
        idempotencyKey: value.idempotencyKey,
        createdBy: user.id,
      })
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "supplier_lifecycle",
      entityId: created.id,
      action: "create",
      after: created,
    });
    return created;
  });
}

export async function closeSupplierLifecycleCase(
  user: SessionUser,
  caseId: number,
  input: unknown,
  dbArg?: AnyDb,
) {
  requireAnyRole(user, "purchasing");
  const value = closeCaseSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());

  return db.transaction(async (tx: AnyDb) => {
    const { current, supplier } = await lockCase(tx, caseId);

    if (current.kind === "payment_term") {
      if (value.expectedVersion == null || value.finalStatus != null
        || !["resolved", "failed"].includes(value.outcome)
        || (value.outcome === "resolved") !== (value.agreement != null)) {
        throw new ApiError(400, "账期谈判须带版本；达成必须登记协议，未达成不登记协议，不能改变准入状态");
      }
    } else if (value.agreement != null) throw new ApiError(400, "准入/整改不能登记谈判协议");

    if (current.status === "closed") {
      const sameFinalStatus =
        value.finalStatus == null || current.supplierStatusAfter === value.finalStatus;
      if (
        current.outcome === value.outcome
        && current.closureNote === value.closureNote
        && sameFinalStatus
        && sameAgreement(current.termAgreement, value.agreement)
      ) return current;
      throw new ApiError(409, "工作项已关闭，不能改写历史结果");
    }

    if (value.expectedVersion != null && current.version !== value.expectedVersion) {
      throw new ApiError(409, "工作项已被更新，请刷新后核对再提交");
    }

    let finalStatus: "pending" | "qualified" | "paused" | "blacklisted";
    if (current.kind === "payment_term") {
      finalStatus = supplier.status;
      if (value.agreement) {
        if (!sameTerms(current.termBaseline, supplier)) {
          throw new ApiError(409, "供应商账期已变化，请在跟进中显式核对当前条款后再登记协议");
        }
        if (!["qualified", "paused"].includes(supplier.status)) throw new ApiError(409, "供应商当前状态不允许登记谈判协议");
        await setSupplierPaymentTerm(supplier.id, {
          paymentTermType: "monthly_credit", creditDays: value.agreement.creditDays,
          paymentTermEffectiveFrom: value.agreement.effectiveFrom, paymentTerm: value.agreement.paymentTerm,
          note: `账期谈判 #${caseId}；${value.agreement.evidenceRef}；${value.closureNote}`,
        }, user, tx);
      }
    } else if (current.kind === "admission") {
      if (!["approved", "rejected"].includes(value.outcome)) {
        throw new ApiError(400, "准入评审结果只能是通过或退回");
      }
      finalStatus = value.outcome === "approved" ? "qualified" : "pending";
    } else {
      if (!["resolved", "failed"].includes(value.outcome)) {
        throw new ApiError(400, "整改结果只能是完成或失败");
      }
      if (value.outcome === "resolved") {
        finalStatus = value.finalStatus === "paused" ? "paused" : "qualified";
      } else {
        if (value.finalStatus !== "paused" && value.finalStatus !== "blacklisted") {
          throw new ApiError(400, "整改失败时必须明确选择暂停或黑名单");
        }
        finalStatus = value.finalStatus;
      }
    }

    if (supplier.status !== finalStatus) {
      const [updatedSupplier] = await tx
        .update(schema.suppliers)
        .set({ status: finalStatus, updatedAt: new Date() })
        .where(eq(schema.suppliers.id, supplier.id))
        .returning();
      await writeAudit(tx, {
        userId: user.id,
        entity: "supplier",
        entityId: supplier.id,
        action: `lifecycle_${finalStatus}`,
        before: supplier,
        after: updatedSupplier,
      });
    }

    const [closed] = await tx
      .update(schema.supplierLifecycleCases)
      .set({
        status: "closed",
        outcome: value.outcome,
        closureNote: value.closureNote,
        supplierStatusAfter: finalStatus,
        closedBy: user.id,
        closedAt: new Date(),
        updatedAt: new Date(),
        version: current.version + 1,
        termAgreement: value.agreement ?? null,
      })
      .where(eq(schema.supplierLifecycleCases.id, caseId))
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "supplier_lifecycle",
      entityId: caseId,
      action: "close",
      before: current,
      after: closed,
    });
    return closed;
  });
}

/** Follow-up is an audited optimistic update, not a second source of supplier terms. */
export async function followUpSupplierLifecycleCase(user: SessionUser, caseId: number, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "purchasing");
  const value = followUpSchema.parse(input);
  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    const { current, supplier } = await lockCase(tx, caseId);
    if (current.status !== "open" || current.version !== value.expectedVersion) {
      throw new ApiError(409, "工作项已关闭或被更新，请刷新后核对");
    }
    if (value.confirmCurrentTerm && current.kind !== "payment_term") throw new ApiError(400, "仅账期谈判可核对账期基线");
    if (value.dueDate && value.dueDate !== current.dueDate && value.dueDate < todayShanghai()) throw new ApiError(400, "新截止日不能早于今天");
    if (value.confirmCurrentTerm && (!value.confirmedTerm || !sameTerms(value.confirmedTerm, supplier))) {
      throw new ApiError(409, "待核对条款已再次变化，请刷新后确认实际看到的条款");
    }
    if (value.ownerId != null) await requireActiveBuyer(tx, value.ownerId);
    const [updated] = await tx.update(schema.supplierLifecycleCases).set({
      ownerId: value.ownerId ?? current.ownerId, dueDate: value.dueDate ?? current.dueDate,
      progressNote: value.note, version: current.version + 1, updatedAt: new Date(),
      termBaseline: value.confirmCurrentTerm ? termSnapshot(supplier) : current.termBaseline,
    }).where(eq(schema.supplierLifecycleCases.id, caseId)).returning();
    await writeAudit(tx, { userId: user.id, entity: "supplier_lifecycle", entityId: caseId,
      action: "follow_up", before: current, after: { ...updated, confirmedCurrentTerm: value.confirmCurrentTerm } });
    return updated;
  });
}
