import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { sql } from "drizzle-orm";
async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const rows = await db
    .select({ code: schema.skus.code, name: schema.skus.name })
    .from(schema.skus)
    .where(sql`${schema.skus.attrs}->>'source' = 'shell_import_2026-07-24'`);
  const byPfx = new Map<string, string[]>();
  for (const r of rows) {
    const pfx = (r.code.match(/^[A-Za-z]+/) ?? ["?"])[0].toUpperCase();
    const list = byPfx.get(pfx) ?? [];
    if (list.length < 4) list.push(`${r.code} ${r.name.slice(0, 26)}`);
    byPfx.set(pfx, list);
  }
  const counts = new Map<string, number>();
  for (const r of rows) {
    const pfx = (r.code.match(/^[A-Za-z]+/) ?? ["?"])[0].toUpperCase();
    counts.set(pfx, (counts.get(pfx) ?? 0) + 1);
  }
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`\n== ${k} (${v}) ==`);
    (byPfx.get(k) ?? []).forEach((s) => console.log("  ", s));
  }
}
void main();
