/** dev 库快速巡检：npx tsx scripts/db-peek.ts */
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { sql } from "drizzle-orm";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const staging = await db
    .select({ t: schema.stagingRows.targetTable, s: schema.stagingRows.status, c: sql<number>`count(*)::int` })
    .from(schema.stagingRows)
    .groupBy(schema.stagingRows.targetTable, schema.stagingRows.status)
    .orderBy(schema.stagingRows.targetTable);
  console.log("STAGING:"); console.table(staging);
  const exc = await db
    .select({ t: schema.aliasExceptions.aliasType, s: schema.aliasExceptions.status, c: sql<number>`count(*)::int` })
    .from(schema.aliasExceptions)
    .groupBy(schema.aliasExceptions.aliasType, schema.aliasExceptions.status);
  console.log("EXCEPTIONS:"); console.table(exc);
  for (const [label, table] of [["skus", schema.skus], ["spus", schema.spus], ["suppliers", schema.suppliers], ["warehouses", schema.warehouses], ["boms", schema.boms], ["salesMonthly", schema.salesMonthly], ["batchStocks", schema.batchStocks], ["processingFeeRefs", schema.processingFeeRefs]] as const) {
    const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(table as never);
    console.log(`${label}: ${c}`);
  }
}
void main();
