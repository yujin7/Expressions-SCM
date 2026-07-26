/** 补遗：费用候选中的 OEM 简码建档+认领（同 populate-stage 规则），随后重放费用放行 */
import { eq } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { claimAlias, resolveAlias } from "../src/server/modules/dimension/resolver";
import { releaseFeeRefs, releaseStatus, type ReleaseUser } from "../src/server/modules/release/engine";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  const admin: ReleaseUser = { id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover };

  const dry = await releaseFeeRefs(admin, { dryRun: true });
  const rawSet = new Set<string>();
  for (const b of dry.blocked) {
    const raw = b.supplierRaw.trim();
    if (raw && raw !== "/" && raw !== "待定") rawSet.add(raw);
  }
  let created = 0, claimed = 0;
  for (const raw of rawSet) {
    if ((await resolveAlias(db, "supplier_oem", raw)) != null) continue;
    const code = "OEM-" + raw.replace(/[^\w一-龥-]/g, "").slice(0, 20);
    let [sup] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.code, code));
    if (!sup) {
      [sup] = await db
        .insert(schema.suppliers)
        .values({ code, name: `${raw}（OEM，全称待补）`, shortName: raw, kinds: ["processor"], status: "qualified" })
        .returning();
      created++;
    }
    await claimAlias(db, { aliasType: "supplier_oem", rawValue: raw, targetId: sup.id, userId: admin.id });
    claimed++;
  }
  console.log("suppliers:", JSON.stringify({ created, claimed, names: [...rawSet] }));
  const res = await releaseFeeRefs(admin, { dryRun: false });
  console.log("feeRefs:", JSON.stringify({ created: res.created, existing: res.existing, blocked: res.blocked.length }));
  const st = await releaseStatus();
  console.log(JSON.stringify(st.tables.map((t) => ({ t: t.targetTable, staged: t.staged, committed: t.committed }))));
}
void main();
