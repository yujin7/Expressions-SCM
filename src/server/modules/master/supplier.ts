import { eq, ilike, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTx = any;
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { supplierSchema } from "./schemas";

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
    })
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "supplier", entityId: created.id, action: "create", after: created });
  }
  return created;
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
      paymentTerm: v.paymentTerm ?? null,
      bankAccount: v.bankAccount ?? null,
      level: v.level ?? null,
      licenseExpiry: v.licenseExpiry ?? null,
      // 常规档案编辑不能绕过准入/整改闭环改状态。
      status: existing.status,
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
