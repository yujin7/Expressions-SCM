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
  const { readdirSync, readFileSync, mkdirSync, writeFileSync, readFileSync: rf, existsSync, unlinkSync } =
    await import("node:fs");
  const path = await import("node:path");
  mkdirSync(dir, { recursive: true });

  /* ── 单写者闸（2026-07-26 事故整改）──
     PGlite 数据目录只允许一个写者。当天两个会话各自起过 dev server、还有脚本直连过同一目录，
     并发写把 WAL 的检查点记录写坏：`invalid checkpoint record` → PANIC → 全应用 500，
     最后靠 pg_resetwal 回退到检查点才救回来（业务数据无损，但丢了检查点之后的写入）。
     PGlite 自己不拦——它照写 postmaster.pid，里面是合成 PID(-42)，无法据此判活。
     所以这里自己下一把带**真实 PID** 的锁：已有活着的写者就**当场拒绝启动**，
     宁可起不来，也不要两个进程一起把库写坏。 */
  /* 锁文件必须放在数据目录**之外**：PGlite 要求目录要么为空（走 initdb）、要么是合法 PG 数据目录，
     锁文件放进去会让全新目录变成「非空且非 PG 目录」，PGlite 直接 abort——
     首版就是这么写的，被 tests/redteam/master-bom-category 当场抓出（该用例用临时空目录）。 */
  const lockPath = path.resolve(`${dir.replace(/\/+$/, "")}.writer.lock`);
  if (existsSync(lockPath)) {
    const prev = Number((rf(lockPath, "utf8") || "").trim());
    let alive = false;
    if (Number.isInteger(prev) && prev > 0 && prev !== process.pid) {
      try {
        process.kill(prev, 0); // signal 0：只探活不发信号
        alive = true;
      } catch {
        alive = false; // 进程已退出 → 陈旧锁，可安全接管
      }
    }
    if (alive) {
      throw new Error(
        `PGlite 数据目录已被 PID ${prev} 占用：${dir}\n` +
          `同一目录只能有一个写者，两个进程同时写会损坏 WAL（2026-07-26 已发生过一次）。\n` +
          `先停掉那个进程（kill ${prev}），或换一个 DATABASE_URL；` +
          `确认它确已退出则删除 ${lockPath} 后重试。`,
      );
    }
    unlinkSync(lockPath); // 陈旧锁：原持有者已不在
  }
  writeFileSync(lockPath, String(process.pid), "utf8");
  const releaseLock = () => {
    try {
      if (existsSync(lockPath) && (rf(lockPath, "utf8") || "").trim() === String(process.pid)) unlinkSync(lockPath);
    } catch {
      /* 退出路径上不因清锁失败再抛 */
    }
  };
  process.once("exit", releaseLock);
  process.once("SIGINT", () => { releaseLock(); process.exit(0); });
  process.once("SIGTERM", () => { releaseLock(); process.exit(0); });

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

/** @deprecated 始终拒绝同步调用的旧入口；所有环境均须 await getDbAsync()。保留显式迁移错误，不提供同步兼容。 */
export function getDb(): DB {
  throw new Error("getDb() 已由 getDbAsync() 取代（支持 PGlite 开发模式）——请改用 await getDbAsync()");
}

export { schema };
