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
