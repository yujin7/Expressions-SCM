import { eq, ilike, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTx = any;
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { warehouseSchema } from "./schemas";

function buildWhere(q: string) {
  return q ? or(ilike(schema.warehouses.code, `%${q}%`), ilike(schema.warehouses.name, `%${q}%`)) : undefined;
}

export async function listWarehouses(q: string, page: number, pageSize: number) {
  const db = await getDbAsync();
  const where = buildWhere(q);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: schema.warehouses.id,
        code: schema.warehouses.code,
        name: schema.warehouses.name,
        kind: schema.warehouses.kind,
        accountingMode: schema.warehouses.accountingMode,
        supplierId: schema.warehouses.supplierId,
        supplierName: schema.suppliers.name,
        parentId: schema.warehouses.parentId,
        active: schema.warehouses.active,
      })
      .from(schema.warehouses)
      .leftJoin(schema.suppliers, eq(schema.warehouses.supplierId, schema.suppliers.id))
      .where(where)
      .orderBy(schema.warehouses.code)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(schema.warehouses).where(where),
  ]);
  return { data: rows, total };
}

/** @param actor 写入者；审计与写入同事务（路由层补记不原子，见 master/sku.ts 注释） */
export async function createWarehouse(input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = warehouseSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  const [created] = await tx
    .insert(schema.warehouses)
    .values({
      code: v.code,
      name: v.name,
      kind: v.kind,
      // 快照仓账务模式=snapshot，其余实时
      accountingMode: v.kind === "snapshot" ? "snapshot" : "realtime",
      supplierId: v.kind === "outsource" ? (v.supplierId ?? null) : null,
      parentId: v.parentId ?? null,
      active: v.active,
    })
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "warehouse", entityId: created.id, action: "create", after: created });
  }
  return created;
  });
}

export async function updateWarehouse(id: number, input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = warehouseSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
  const [existing] = await tx.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
  if (!existing) throw new ApiError(404, "仓库不存在");
  const [updated] = await tx
    .update(schema.warehouses)
    .set({
      code: v.code,
      name: v.name,
      kind: v.kind,
      accountingMode: v.kind === "snapshot" ? "snapshot" : "realtime",
      supplierId: v.kind === "outsource" ? (v.supplierId ?? null) : null,
      parentId: v.parentId === id ? null : (v.parentId ?? null), // 不许自指
      active: v.active,
    })
    .where(eq(schema.warehouses.id, id))
    .returning();
  if (actor) {
    await writeAudit(tx, { userId: actor.id, entity: "warehouse", entityId: id, action: "update", before: existing, after: updated });
  }
  return updated;
  });
}
