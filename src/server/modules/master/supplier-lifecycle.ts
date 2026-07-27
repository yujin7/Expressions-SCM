import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync, schema } from "@/db";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- services accept the production DB or an isolated PGlite transaction
type AnyDb = any;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD");
const supplierStatus = z.enum(["pending", "qualified", "paused", "blacklisted"]);

const openCaseSchema = z.object({
  supplierId: z.number().int().positive(),
  kind: z.enum(["admission", "corrective"]),
  priority: z.enum(["normal", "high", "critical"]).default("normal"),
  reason: z.string().trim().min(5, "请填写至少 5 个字的准入依据或整改原因").max(500),
  dueDate: dateString,
  pauseNewOrders: z.boolean().optional().default(false),
  idempotencyKey: z.string().uuid(),
});

const closeCaseSchema = z.object({
  outcome: z.enum(["approved", "rejected", "resolved", "failed"]),
  finalStatus: supplierStatus.optional(),
  closureNote: z.string().trim().min(5, "请填写至少 5 个字的完成证据").max(1000),
});

export interface SupplierLifecycleRow {
  id: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  supplierStatus: string;
  kind: "admission" | "corrective";
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
  },
  dbArg?: AnyDb,
) {
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
    query.kind === "admission" || query.kind === "corrective"
      ? eq(schema.supplierLifecycleCases.kind, query.kind)
      : undefined,
    query.supplierId ? eq(schema.supplierLifecycleCases.supplierId, query.supplierId) : undefined,
  ].filter(Boolean);
  const conditions = [
    ...scopeConditions,
    query.status === "open" || query.status === "closed"
      ? eq(schema.supplierLifecycleCases.status, query.status)
      : undefined,
  ].filter(Boolean);
  const where = conditions.length ? and(...conditions) : undefined;

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
  };

  const [rawRows, totalRows] = await Promise.all([
    db
      .select(baseSelect)
      .from(schema.supplierLifecycleCases)
      .innerJoin(schema.suppliers, eq(schema.supplierLifecycleCases.supplierId, schema.suppliers.id))
      .where(where)
      .orderBy(
        sql`CASE ${schema.supplierLifecycleCases.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END`,
        schema.supplierLifecycleCases.dueDate,
        desc(schema.supplierLifecycleCases.id),
      )
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
    })
    .from(schema.supplierLifecycleCases)
    .innerJoin(schema.suppliers, eq(schema.supplierLifecycleCases.supplierId, schema.suppliers.id))
    .where(scopeConditions.length ? and(...scopeConditions) : undefined);

  return {
    rows: await hydrateRows(db, rawRows),
    total: Number(totalRows[0]?.total ?? 0),
    summary: {
      open: Number(summary?.open ?? 0),
      overdue: Number(summary?.overdue ?? 0),
      admissions: Number(summary?.admissions ?? 0),
      corrective: Number(summary?.corrective ?? 0),
    },
  };
}

export async function openSupplierLifecycleCase(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
) {
  requireAnyRole(user, "purchasing");
  const value = openCaseSchema.parse(input);
  if (value.dueDate < todayShanghai()) throw new ApiError(400, "截止日不能早于今天");
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
        && replayed.pauseNewOrders === value.pauseNewOrders;
      if (!sameRequest) {
        throw new ApiError(409, "幂等键已绑定不同的供应商工作项请求");
      }
      return replayed;
    }

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
        ownerId: user.id,
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
    await tx.execute(sql`SELECT id FROM supplier_lifecycle_cases WHERE id = ${caseId} FOR UPDATE`);
    const [current] = await tx
      .select()
      .from(schema.supplierLifecycleCases)
      .where(eq(schema.supplierLifecycleCases.id, caseId));
    if (!current) throw new ApiError(404, "供应商工作项不存在");

    if (current.status === "closed") {
      const sameFinalStatus =
        value.finalStatus == null || current.supplierStatusAfter === value.finalStatus;
      if (
        current.outcome === value.outcome
        && current.closureNote === value.closureNote
        && sameFinalStatus
      ) return current;
      throw new ApiError(409, "工作项已关闭，不能改写历史结果");
    }

    const [supplier] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, current.supplierId));
    if (!supplier) throw new ApiError(404, "供应商不存在");

    let finalStatus: "pending" | "qualified" | "paused" | "blacklisted";
    if (current.kind === "admission") {
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
