import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { and, eq, inArray } from "drizzle-orm";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const rows = await db
    .select({ payload: schema.stagingRows.payload })
    .from(schema.stagingRows)
    .where(and(eq(schema.stagingRows.targetTable, "bom_block"), inArray(schema.stagingRows.status, ["pending", "validated"])));
  const byInfix = new Map<string, { count: number; samples: string[] }>();
  for (const r of rows) {
    const b = r.payload as { lines?: { materialCode: string | null; materialName: string; segment: string }[] };
    for (const l of b.lines ?? []) {
      if (l.segment !== "unknown" || !l.materialCode) continue;
      const m = l.materialCode.toUpperCase().match(/-(\d{4})/);
      const infix = m ? m[1] : "(无四位段)";
      const e = byInfix.get(infix) ?? { count: 0, samples: [] };
      e.count++;
      if (e.samples.length < 6 && !e.samples.some((s) => s.includes(l.materialName.slice(0, 6))))
        e.samples.push(`${l.materialCode} ${l.materialName.slice(0, 24)}`);
      byInfix.set(infix, e);
    }
  }
  for (const [k, v] of [...byInfix.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`\n== ${k} (${v.count} 行) ==`);
    v.samples.forEach((s) => console.log("  ", s));
  }
}
void main();
