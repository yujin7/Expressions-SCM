/** E 项：sku_leadtime staging → sku_params 正式表（须停 dev server；迁移由 getDbAsync 自动应用） */
import { eq } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { releaseSkuParams, type ReleaseUser } from "../src/server/modules/release/engine";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  const admin: ReleaseUser = { id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover };
  const dry = await releaseSkuParams(admin, { dryRun: true }, db);
  console.log("dryRun:", JSON.stringify(dry));
  const res = await releaseSkuParams(admin, { dryRun: false }, db);
  console.log("release:", JSON.stringify(res));
  const [{ c }] = (await db.execute("select count(*)::int c from sku_params")).rows as unknown as { c: number }[];
  console.log("sku_params rows:", c);
}
void main();
