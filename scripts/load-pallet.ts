import { eq } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { stagePallet } from "../src/server/import/adapters/pallet";
import { releaseTransitRefs, type ReleaseUser } from "../src/server/modules/release/engine";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  const admin: ReleaseUser = { id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover };
  const st = await stagePallet(db, "/Users/yj/Desktop/SCM/6月份总货盘情况表-PMC.xlsx", admin.id);
  console.log("staging:", JSON.stringify(st.stats));
  const rel = await releaseTransitRefs(admin, { dryRun: false });
  console.log("release:", JSON.stringify(rel));
}
void main();
