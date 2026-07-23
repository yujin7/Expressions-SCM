import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** 事务句柄类型：service 层统一用它，便于 PGlite 测试注入 */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * 双驱动：
 * - DATABASE_URL=postgres://…  → node-postgres（生产/联调，docker-compose）
 * - DATABASE_URL=pglite:<dir>  或未设置 → 内嵌 PGlite（零依赖本地开发），首次启动自动应用 drizzle/*.sql 迁移
 * globalThis 缓存防 Next dev HMR 重复实例化。
 */
const g = globalThis as unknown as { __scmDb?: Promise<DB> };

async function createDb(): Promise<DB> {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("postgres")) {
    const { Pool } = await import("pg");
    return drizzlePg(new Pool({ connectionString: url }), { schema });
  }
  // PGlite 开发模式
  const dir = url.startsWith("pglite:") ? url.slice("pglite:".length) : ".data/dev";
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { readdirSync, readFileSync, mkdirSync } = await import("node:fs");
  const path = await import("node:path");
  mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  await client.waitReady;
  // 幂等迁移：记录已应用文件
  await client.exec(`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
  const migDir = path.resolve(process.cwd(), "drizzle");
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await client.query(`SELECT 1 FROM _migrations WHERE name = $1`, [f]);
    if (done.rows.length) continue;
    const sqlText = readFileSync(path.join(migDir, f), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await client.exec(s);
    }
    await client.query(`INSERT INTO _migrations(name) VALUES ($1)`, [f]);
  }
  return drizzlePglite(client, { schema }) as unknown as DB;
}

export function getDbAsync(): Promise<DB> {
  g.__scmDb ??= createDb();
  return g.__scmDb;
}

/** @deprecated 仅限已确认 postgres:// 环境的同步调用；新代码一律 await getDbAsync() */
export function getDb(): DB {
  throw new Error("getDb() 已由 getDbAsync() 取代（支持 PGlite 开发模式）——请改用 await getDbAsync()");
}

export { schema };
