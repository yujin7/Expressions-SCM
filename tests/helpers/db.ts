import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/db/schema";

/**
 * 测试数据库：PGlite 内存 Postgres，应用 drizzle/ 下生成的迁移 SQL。
 * 用法：const { db } = await createTestDb();
 * 注意：迁移由 `npm run db:generate` 产出——schema 变更后须重新生成。
 */
export async function createTestDb() {
  const client = new PGlite();
  const dir = path.resolve(__dirname, "../../drizzle");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sqlText = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await client.exec(s);
    }
  }
  const db = drizzle(client, { schema });
  return { db, client };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
