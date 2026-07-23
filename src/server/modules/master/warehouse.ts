import { eq, ilike, or, sql } from "drizzle-orm";
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

export async function createWarehouse(input: unknown) {
  const v = warehouseSchema.parse(input);
  const db = await getDbAsync();
  const [created] = await db
    .insert(schema.warehouses)
    .values({
      code: v.code,
      name: v.name,
      kind: v.kind,
      // 快照仓账务模式=snapshot，其余实时
      accountingMode: v.kind === "snapshot" ? "snapshot" : "realtime",
      supplierId: v.kind === "outsource" ? (v.supplierId ?? null) : null,
      active: v.active,
    })
    .returning();
  return created;
}

export async function updateWarehouse(id: number, input: unknown) {
  const v = warehouseSchema.parse(input);
  const db = await getDbAsync();
  const [existing] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
  if (!existing) throw new ApiError(404, "仓库不存在");
  const [updated] = await db
    .update(schema.warehouses)
    .set({
      code: v.code,
      name: v.name,
      kind: v.kind,
      accountingMode: v.kind === "snapshot" ? "snapshot" : "realtime",
      supplierId: v.kind === "outsource" ? (v.supplierId ?? null) : null,
      active: v.active,
    })
    .where(eq(schema.warehouses.id, id))
    .returning();
  return updated;
}
