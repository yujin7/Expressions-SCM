import { eq, ilike, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTx = any;
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { supplierCapacitySchema, supplierPaymentTermSchema, supplierSchema } from "./schemas";

function buildWhere(q: string) {
  return q ? or(ilike(schema.suppliers.code, `%${q}%`), ilike(schema.suppliers.name, `%${q}%`)) : undefined;
}

export async function listSuppliers(q: string, page: number, pageSize: number) {
  const db = await getDbAsync();
  const where = buildWhere(q);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: schema.suppliers.id,
        code: schema.suppliers.code,
        name: schema.suppliers.name,
        kinds: schema.suppliers.kinds,
        contact: schema.suppliers.contact,
        licenseExpiry: schema.suppliers.licenseExpiry,
        status: schema.suppliers.status,
      })
      .from(schema.suppliers)
      .where(where)
      .orderBy(schema.suppliers.code)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.suppliers).where(where),
  ]);
  return { data: rows, total };
}

/** 编辑使用完整 DTO；路由层负责按角色剥离 bankAccount。 */
export async function getSupplier(id: number, dbArg?: AnyTx) {
  const db: AnyTx = dbArg ?? (await getDbAsync());
  const [row] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
  if (!row) throw new ApiError(404, "供应商不存在");
  return row;
}

/**
 * @param actor 写入者。审计必须与写入同事务——路由层补记用的是新连接、且在提交之后，
 *   进程挂在中间就留下「有数据无审计」。供应商含银行账户等敏感字段，留痕尤其不能有洞。
 */
export async function createSupplier(input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = supplierSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  const [created] = await tx
    .insert(schema.suppliers)
    .values({
      code: v.code,
      name: v.name,
      kinds: v.kinds,
      contact: v.contact ?? null,
      phone: v.phone ?? null,
      email: v.email ?? null,
      address: v.address ?? null,
      paymentTerm: v.paymentTerm ?? null,
      bankAccount: v.bankAccount ?? null,
      level: v.level ?? null,
      licenseExpiry: v.licenseExpiry ?? null,
      status: v.status ?? "pending",
      ...termAndCapacityColumns(v),
    })
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "supplier", entityId: created.id, action: "create", after: created });
  }
  return created;
  });
}

/** D64 账期三列 + 产能三列（档案通用写路径与专用写路径共用同一归一化） */
function termAndCapacityColumns(v: {
  paymentTermType?: string | null;
  creditDays?: number | null;
  paymentTermEffectiveFrom?: string | null;
  declaredMonthlyCapacity?: string | null;
  capacityUom?: string | null;
  surgeCapacityPct?: number | null;
}) {
  return {
    paymentTermType: v.paymentTermType ?? null,
    creditDays: v.paymentTermType === "monthly_credit" ? (v.creditDays ?? null) : null,
    paymentTermEffectiveFrom: v.paymentTermType == null ? null : (v.paymentTermEffectiveFrom ?? null),
    declaredMonthlyCapacity: v.declaredMonthlyCapacity ?? null,
    capacityUom: v.declaredMonthlyCapacity == null ? null : (v.capacityUom ?? null),
    surgeCapacityPct: v.surgeCapacityPct ?? null,
  };
}

const TERM_CAPACITY_INPUT_KEYS = ["paymentTermType", "creditDays", "paymentTermEffectiveFrom", "declaredMonthlyCapacity", "capacityUom", "surgeCapacityPct"] as const;
const PAYMENT_TERM_COLUMNS = ["paymentTermType", "creditDays", "paymentTermEffectiveFrom", "paymentTerm"] as const;
const CAPACITY_COLUMNS = ["declaredMonthlyCapacity", "capacityUom", "surgeCapacityPct"] as const;

function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = row[k];
  return out;
}

/**
 * D64 账期登记（专用写路径）：只改账期四列，其余档案字段不动；审计 before/after 只含账期字段
 * （变更历史 = audit_logs 上按 entity=supplier + action=payment_term 追溯，不另建表）。
 * 角色：采购/管理员（路由层 guardWrite("supplier")；service 内再判一次，防绕过路由直调）。
 */
export async function setSupplierPaymentTerm(id: number, input: unknown, actor: SessionUser, dbArg?: AnyTx) {
  const v = supplierPaymentTermSchema.parse(input);
  if (!actor.roles.includes("admin") && !actor.roles.includes("purchasing")) {
    throw new ApiError(403, "无权限执行此操作：需要采购/管理员角色");
  }
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
    const [existing] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
    if (!existing) throw new ApiError(404, "供应商不存在");
    const cols = termAndCapacityColumns({ ...v });
    const [updated] = await tx
      .update(schema.suppliers)
      .set({
        paymentTermType: cols.paymentTermType,
        creditDays: cols.creditDays,
        paymentTermEffectiveFrom: cols.paymentTermEffectiveFrom,
        paymentTerm: v.paymentTerm ?? existing.paymentTerm,
        updatedAt: new Date(),
      })
      .where(eq(schema.suppliers.id, id))
      .returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "supplier",
      entityId: id,
      action: "payment_term",
      before: pick(existing, PAYMENT_TERM_COLUMNS),
      after: { ...pick(updated, PAYMENT_TERM_COLUMNS), note: v.note ?? null },
    });
    return pick(updated, ["id", "code", "name", ...PAYMENT_TERM_COLUMNS]);
  });
}

/** 产能申报（专用写路径）：只改产能三列；审计 action=capacity。角色同账期。 */
export async function setSupplierCapacity(id: number, input: unknown, actor: SessionUser, dbArg?: AnyTx) {
  const v = supplierCapacitySchema.parse(input);
  if (!actor.roles.includes("admin") && !actor.roles.includes("purchasing")) {
    throw new ApiError(403, "无权限执行此操作：需要采购/管理员角色");
  }
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
    const [existing] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
    if (!existing) throw new ApiError(404, "供应商不存在");
    const cols = termAndCapacityColumns({ ...v });
    const [updated] = await tx
      .update(schema.suppliers)
      .set({
        declaredMonthlyCapacity: cols.declaredMonthlyCapacity,
        capacityUom: cols.capacityUom,
        surgeCapacityPct: cols.surgeCapacityPct,
        updatedAt: new Date(),
      })
      .where(eq(schema.suppliers.id, id))
      .returning();
    await writeAudit(tx, {
      userId: actor.id,
      entity: "supplier",
      entityId: id,
      action: "capacity",
      before: pick(existing, CAPACITY_COLUMNS),
      after: { ...pick(updated, CAPACITY_COLUMNS), note: v.note ?? null },
    });
    return pick(updated, ["id", "code", "name", ...CAPACITY_COLUMNS]);
  });
}

export async function updateSupplier(id: number, input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = supplierSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  const [existing] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
  if (!existing) throw new ApiError(404, "供应商不存在");
  const [updated] = await tx
    .update(schema.suppliers)
    .set({
      code: v.code,
      name: v.name,
      kinds: v.kinds,
      contact: v.contact ?? null,
      phone: v.phone ?? null,
      email: v.email ?? null,
      address: v.address ?? null,
      // 结算方式原文：请求未携带该键 = 不改（与账期写路径"原文未传 = 不改"一致）
      paymentTerm: input != null && typeof input === "object" && "paymentTerm" in input ? (v.paymentTerm ?? null) : existing.paymentTerm,
      bankAccount: v.bankAccount ?? null,
      level: v.level ?? null,
      licenseExpiry: v.licenseExpiry ?? null,
      // 常规档案编辑不能绕过准入/整改闭环改状态。
      status: existing.status,
      // 审阅修复：档案表单未携带账期/产能字段时保留原值；只有显式提交才按 termAndCapacityColumns 归一化
      ...(TERM_CAPACITY_INPUT_KEYS.some((k) => input != null && typeof input === "object" && k in (input as object)) ? termAndCapacityColumns(v) : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.suppliers.id, id))
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "supplier", entityId: id, action: "update", before: existing, after: updated });
  }
  return updated;
  });
}
