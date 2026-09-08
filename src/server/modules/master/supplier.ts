import { and, eq, ilike, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTx = any;
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { supplierCapacitySchema, supplierPaymentTermSchema, supplierSchema } from "./schemas";
import { SELECTED_OPTIONS_LIMIT, selectedOptionsPredicate, type SelectedOptionValue } from "@/server/core/selected-options";

function buildWhere(q: string) {
  return q ? or(ilike(schema.suppliers.code, `%${q}%`), ilike(schema.suppliers.name, `%${q}%`)) : undefined;
}

export async function listSuppliers(q: string, page: number, pageSize: number, selectedValues?: SelectedOptionValue[]) {
  const db = await getDbAsync();
  const where = and(buildWhere(q), selectedOptionsPredicate(selectedValues, {
    id: schema.suppliers.id, text: [schema.suppliers.code, schema.suppliers.name],
  }));
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
      .limit(selectedValues === undefined ? pageSize : SELECTED_OPTIONS_LIMIT)
      .offset(selectedValues === undefined ? (page - 1) * pageSize : 0),
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
  supplierCapacitySchema.parse(v);
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

const TERM_INPUT_KEYS = ["paymentTermType", "creditDays", "paymentTermEffectiveFrom"] as const;
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
    const [existing] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, id)).for("update");
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
    const [existing] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, id)).for("update");
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

/**
 * 档案通用编辑。
 *
 * 可空字段的写入语义（安全审计 S5，全部按**键是否出现在请求里**判定）：
 *   - 携带该键（含空串——空串经 schema 的 emptyToUndef 变成 undefined）→ 按值写入，空即清空；
 *   - 未携带该键 → 保留原值。
 * 起因是 `bankAccount`：它在 SENSITIVE_FIELDS 里，非价格角色从 GET 拿到的 DTO **根本没有这个键**，
 * 这样的 DTO 原样回传保存，旧写法 `v.bankAccount ?? null` 就把银行账户抹掉了——脱敏本是只读保护，
 * 反而成了写路径上的擦除器。其余可空档案字段（contact/phone/email/address/level/licenseExpiry）
 * 逐个复核后取同一口径：编辑表单清空时键仍在（→ 写 null），所以"清空"照常可用；
 * 而任何不携带该键的局部提交（脱敏 DTO 回传、脚本、集成）不再擦除既有值。
 * code/name/kinds 是必填键，不适用本规则；status 由生命周期状态机独占。
 */
export async function updateSupplier(id: number, input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  // 先验单字段；跨字段约束必须在锁内与未提交旧值合并后验证。
  const v = supplierSchema.innerType().parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  const hasKey = (k: string) => input != null && typeof input === "object" && k in (input as Record<string, unknown>);
  return db.transaction(async (tx: AnyTx) => {
  const [existing] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, id)).for("update");
  if (!existing) throw new ApiError(404, "供应商不存在");
  // 按字段存在性合并，再校验最终组；任一组被提交都不能清空另一组。
  const mergedTerms = TERM_INPUT_KEYS.some(hasKey) ? supplierPaymentTermSchema.parse({
    paymentTermType: hasKey("paymentTermType") ? v.paymentTermType ?? null : existing.paymentTermType,
    creditDays: hasKey("paymentTermType") && v.paymentTermType !== "monthly_credit" ? null
      : hasKey("creditDays") ? v.creditDays ?? null : existing.creditDays,
    paymentTermEffectiveFrom: hasKey("paymentTermType") && v.paymentTermType == null ? null
      : hasKey("paymentTermEffectiveFrom") ? v.paymentTermEffectiveFrom ?? null : existing.paymentTermEffectiveFrom,
  }) : null;
  const mergedCapacity = CAPACITY_COLUMNS.some(hasKey) ? supplierCapacitySchema.parse({
    declaredMonthlyCapacity: hasKey("declaredMonthlyCapacity") ? v.declaredMonthlyCapacity ?? null : existing.declaredMonthlyCapacity,
    capacityUom: hasKey("declaredMonthlyCapacity") && v.declaredMonthlyCapacity == null ? undefined
      : hasKey("capacityUom") ? v.capacityUom : existing.capacityUom ?? undefined,
    surgeCapacityPct: hasKey("surgeCapacityPct") ? v.surgeCapacityPct ?? null : existing.surgeCapacityPct,
  }) : null;
  const [updated] = await tx
    .update(schema.suppliers)
    .set({
      code: v.code,
      name: v.name,
      kinds: v.kinds,
      contact: hasKey("contact") ? (v.contact ?? null) : existing.contact,
      phone: hasKey("phone") ? (v.phone ?? null) : existing.phone,
      email: hasKey("email") ? (v.email ?? null) : existing.email,
      address: hasKey("address") ? (v.address ?? null) : existing.address,
      // 结算方式原文：请求未携带该键 = 不改（与账期写路径"原文未传 = 不改"一致）
      paymentTerm: hasKey("paymentTerm") ? (v.paymentTerm ?? null) : existing.paymentTerm,
      // 敏感字段：脱敏 DTO 里没有这个键，未携带一律保留（绝不按 null 擦除）
      bankAccount: hasKey("bankAccount") ? (v.bankAccount ?? null) : existing.bankAccount,
      level: hasKey("level") ? (v.level ?? null) : existing.level,
      licenseExpiry: hasKey("licenseExpiry") ? (v.licenseExpiry ?? null) : existing.licenseExpiry,
      // 常规档案编辑不能绕过准入/整改闭环改状态。
      status: existing.status,
      ...(mergedTerms ? pick(termAndCapacityColumns(mergedTerms), TERM_INPUT_KEYS) : {}),
      ...(mergedCapacity ? pick(termAndCapacityColumns(mergedCapacity), CAPACITY_COLUMNS) : {}),
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
