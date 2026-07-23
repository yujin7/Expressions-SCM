import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import { claimAlias } from "../src/server/modules/dimension/resolver";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  const brands = await db.select().from(schema.brands);
  const exc = await db.select().from(schema.aliasExceptions)
    .where(and(eq(schema.aliasExceptions.aliasType, "brand"), eq(schema.aliasExceptions.status, "open")));
  for (const e of exc) {
    const b = brands.find((x) => x.code === e.rawValue || x.nameCn === e.rawValue);
    if (b) {
      await claimAlias(db, { aliasType: "brand", rawValue: e.rawValue, targetId: b.id, userId: admin.id });
      console.log("claimed", e.rawValue, "->", b.code);
    } else console.log("no match", e.rawValue);
  }
}
void main();
