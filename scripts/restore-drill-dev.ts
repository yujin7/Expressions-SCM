/** 恢复演练（dev/PGlite 口径）：解开已完成的停机备份 → 独立打开 → 核对行数。 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

async function count(db: PGlite, table: string): Promise<number> {
  const r = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table}`);
  return r.rows[0].c;
}

async function main() {
  const backupDir = path.resolve(process.env.DEV_BACKUP_DIR ?? "backups/dev");
  const requested = process.env.DEV_BACKUP_FILE?.trim();
  const latest = existsSync(backupDir)
    ? readdirSync(backupDir)
        .filter((name) => /^dev_\d{14}\.tgz$/.test(name))
        .sort()
        .at(-1)
    : undefined;
  const archive = path.resolve(requested || (latest ? path.join(backupDir, latest) : ""));
  if (!requested && !latest) {
    throw new Error("没有可演练的停机备份；先停止 dev server 并运行 npm run db:backup");
  }
  if (!existsSync(archive)) throw new Error(`备份文件不存在：${archive}`);

  const tmp = mkdtempSync(path.join(tmpdir(), "restore-drill-"));
  const t0 = Date.now();
  execFileSync("tar", ["xzf", archive, "-C", tmp]);
  const extractMs = Date.now() - t0;
  const roots = readdirSync(tmp);
  if (roots.length !== 1) throw new Error(`备份包根目录数量异常：${roots.join(",")}`);
  const dst = path.join(tmp, roots[0]);

  const t1 = Date.now();
  const db = new PGlite(dst);
  const tables = [
    "_migrations",
    "users",
    "skus",
    "spus",
    "stock_ledger",
    "stock_balances",
    "stock_snapshots",
    "transit_refs",
    "review_items",
    "sales_monthly",
    "batch_stocks",
    "boms",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await count(db, t);
  await db.close();
  const verifyMs = Date.now() - t1;
  const migrationFiles = readdirSync(path.resolve("drizzle")).filter((name) => name.endsWith(".sql")).length;
  const ok = out._migrations === migrationFiles && out.users > 0;
  rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok,
    archive,
    extractMs,
    verifyMs,
    migrationFiles,
    counts: out,
  }));
  if (!ok) process.exitCode = 1;
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
