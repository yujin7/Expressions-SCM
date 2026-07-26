/** 在途进度表全量入库（须停 dev server）：staging → 在途参考放行 + 起订量放行 */
import { eq } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { stageTransit } from "../src/server/import/adapters/transit";
import { stageLeadtime } from "../src/server/import/adapters/leadtime";
import { releaseFinishedMoq, releaseTransitRefs, type ReleaseUser } from "../src/server/modules/release/engine";

const FILE = "/Users/yj/Desktop/SCM/2026年成品在途订单实时进度表---新版.xlsx";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  const admin: ReleaseUser = { id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover };

  const st = await stageTransit(db, FILE, admin.id);
  console.log("staging:", JSON.stringify(st.stats));
  const lt = await stageLeadtime(db, FILE, admin.id); // 新版周期表重导（旧 pending 行被 supersede）
  console.log("leadtime restage:", JSON.stringify(lt.stats));

  const rel = await releaseTransitRefs(admin, { dryRun: false });
  console.log("transit release:", JSON.stringify(rel));
  const moq = await releaseFinishedMoq(admin, { dryRun: false });
  console.log("moq release:", JSON.stringify(moq));
}
void main();
