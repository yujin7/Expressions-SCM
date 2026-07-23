import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { eq, like, sql } from "drizzle-orm";
async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  console.table(await db.select({ id: schema.brands.id, code: schema.brands.code, nameCn: schema.brands.nameCn, nameEn: schema.brands.nameEn }).from(schema.brands));
  const shells = await db.select({ name: schema.skus.name }).from(schema.skus).where(sql`${schema.skus.attrs}->>'source' = 'shell_import_2026-07-24'`).limit(0);
  const pfx = await db.select({ p: sql<string>`substring(${schema.skus.name} from '^[（(]([^）)]+)[）)]')`, c: sql<number>`count(*)::int` })
    .from(schema.skus).where(sql`${schema.skus.attrs}->>'source' = 'shell_import_2026-07-24'`)
    .groupBy(sql`1`).orderBy(sql`2 desc`);
  console.table(pfx);
}
void main();
