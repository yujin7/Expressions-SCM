import { eq } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { releaseFeeRefs, type ReleaseUser } from "../src/server/modules/release/engine";
async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  const admin: ReleaseUser = { id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover };
  const dry = await releaseFeeRefs(admin, { dryRun: true });
  const byReason = new Map<string, { count: number; samples: string[] }>();
  for (const b of dry.blocked) {
    const e = byReason.get(b.reason) ?? { count: 0, samples: [] };
    e.count++;
    if (e.samples.length < 5) e.samples.push(`${b.productCode ?? "?"} | ${b.supplierRaw}`);
    byReason.set(b.reason, e);
  }
  for (const [r, e] of byReason) console.log(`\n== ${r} (${e.count})\n  ${e.samples.join("\n  ")}`);
}
void main();
