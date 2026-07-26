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

    let applied = -1;
    try {
      const r = await db.execute(sql`SELECT count(*)::int AS c FROM _migrations`);
      applied = Number((r.rows?.[0] as { c?: number })?.c ?? -1);
    } catch {
      applied = -2; // 非 PGlite 模式（PG 走 drizzle-kit migrate，无 _migrations 表）
    }
    const drift = applied >= 0 && applied < files;
    return NextResponse.json(
      { ok: !drift, migrationFiles: files, applied, drift, hint: drift ? "schema 漂移：请重启 dev server（迁移仅在启动时应用）" : undefined },
      { status: drift ? 503 : 200 },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
