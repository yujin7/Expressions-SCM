import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/db/schema";

/**
 * 测试数据库：PGlite 内存 Postgres，应用 drizzle/ 下生成的迁移 SQL。
 * 用法：const { db } = await createTestDb();
 * 注意：迁移由 `npm run db:generate` 产出——schema 变更后须重新生成。
 *
 * ── 为什么用快照克隆而不是每次重放迁移 ──
 * 74 个测试文件用 PGlite，其中 19 个**每个用例各建一次库**（posting/engine 建 10 次、
 * scoped-params 7 次、password 7 次…）。每次建库原本要 readdir + 逐个 readFile + 重放
 * 全部 19 个迁移文件。
 *
 * **实测收益（A/B 各跑两次，2026-07-26）**：
 *   单文件（开发时最常见跑法）scoped-params：6.6s → 3.0s，**2.2×**
 *   全量套件：23.2/24.5s → 24.8/25.4s，**没有变快，反而略慢**
 * 全量套件跑在 16 个 worker 上、瓶颈是 CPU 争用，而每个 worker 都要各自建一次模板快照，
 * 于是省下的重放时间被建模板的成本吃掉。**保留本改动是为开发迭代的单文件跑法**，
 * 不是为 CI。别把它当成"套件提速"——那正是本仓有过前科的假提速叙事。
 *
 * **不能靠共用一个库来省**——那会让用例之间互相看到对方写的数据，
 * 变成顺序相关的脆弱测试；posting/engine 这类要断言精确台账条数的用例首当其冲。
 * 所以这里保持「每次调用都是全新隔离实例」，只是把「重放迁移」换成
 * 「加载一份已迁移好的快照」：迁移在本 worker 内只跑一次，之后每个实例从 Blob 克隆。
 * 隔离性一模一样，单文件内成本从 O(用例数 × 迁移数) 降到 O(迁移数)。
 */

/** 本 worker 内共享的「已迁移空库」快照；vitest 每个 worker 各自持有一份 */
let templatePromise: Promise<Blob> | null = null;

async function buildTemplate(): Promise<Blob> {
  const client = new PGlite();
  const dir = path.resolve(__dirname, "../../drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sqlText = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await client.exec(s);
    }
  }
  const dump = await client.dumpDataDir("none"); // 不压缩：测试内存态，省掉 gzip 往返
  await client.close();
  return dump as Blob;
}

export async function createTestDb() {
  templatePromise ??= buildTemplate();
  const client = new PGlite({ loadDataDir: await templatePromise });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];
