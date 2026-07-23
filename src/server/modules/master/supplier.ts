import { eq, ilike, or, sql } from "drizzle-orm";
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

export async function createSupplier(input: unknown) {
  const v = supplierSchema.parse(input);
  const db = await getDbAsync();
  const [created] = await db
    .insert(schema.suppliers)
    .values({
      code: v.code,
      name: v.name,
      kinds: v.kinds,
      contact: v.contact ?? null,
      licenseExpiry: v.licenseExpiry ?? null,
      status: v.status,
    })
    .returning();
  return created;
}

export async function updateSupplier(id: number, input: unknown) {
  const v = supplierSchema.parse(input);
  const db = await getDbAsync();
  const [existing] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, id));
  if (!existing) throw new ApiError(404, "供应商不存在");
  const [updated] = await db
    .update(schema.suppliers)
    .set({
      code: v.code,
      name: v.name,
      kinds: v.kinds,
      contact: v.contact ?? null,
      licenseExpiry: v.licenseExpiry ?? null,
      status: v.status,
      updatedAt: new Date(),
    })
    .where(eq(schema.suppliers.id, id))
    .returning();
  return updated;
}
