import { NextResponse } from "next/server";
import { readdirSync } from "node:fs";
import path from "node:path";
import { getDbAsync } from "@/db";
import { sql } from "drizzle-orm";

/** 健康检查：暴露 schema 漂移（UX 走查环境级发现——迁移文件数 vs 已应用数不一致=热更新后未重启） */
export async function GET() {
  try {
    const files = readdirSync(path.resolve(process.cwd(), "drizzle")).filter((f) => f.endsWith(".sql")).length;
    const db = await getDbAsync();

    /* 先探活，再谈漂移。
       原实现只查 _migrations，而该查询失败会被内层 catch 统一降级成 applied=-2
       （「PG 模式正常」的合法取值）——数据库整个连不上时，健康检查照样返回 ok:true/200。
       探活必须是独立的一步：SELECT 1 失败＝不健康，绝不能与「这个模式没有这张表」混为一谈。 */
    await db.execute(sql`SELECT 1`);

    /* 两种模式各有各的迁移账本：
         PGlite（开发）→ `_migrations`
         PostgreSQL（生产）→ `drizzle.__drizzle_migrations`（drizzle-kit migrate 写的）

       原实现只会查前者，查不到就置 applied=-2，而 drift 判据是 `applied >= 0 && applied < files`
       —— 于是**生产模式下 drift 恒为 false，漂移检测形同虚设**。
       这正好把护栏关在了最需要它的环境：开发机重启一下就好，生产漏迁移是要出事的。
       现在两张表都查，谁在就用谁；两张都没有才是真的"数不出来"。 */
    let applied = -1;
    for (const stmt of [
      sql`SELECT count(*)::int AS c FROM _migrations`,
      sql`SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations`,
    ]) {
      try {
        const r = await db.execute(stmt);
        applied = Number((r.rows?.[0] as { c?: number })?.c ?? -1);
        if (applied >= 0) break;
      } catch { /* 该模式没有这张账本，试下一张 */ }
    }
    const drift = applied >= 0 && applied < files;
    return NextResponse.json(
      { ok: !drift, migrationFiles: files, applied, drift, hint: drift
          ? "schema 漂移：已应用迁移少于仓库迁移文件。开发（PGlite）重启 dev server 即可；生产（PostgreSQL）需执行 drizzle-kit migrate 后再重启。"
          : undefined },
      { status: drift ? 503 : 200 },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
