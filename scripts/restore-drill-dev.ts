/** 恢复演练（dev/PGlite 口径）：备份 .data/dev → 还原到临时目录 → 独立打开 → 核对行数 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

async function count(db: PGlite, table: string): Promise<number> {
  const r = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table}`);
  return r.rows[0].c;
}

async function main() {
  const src = path.resolve(".data/dev");
  const tmp = mkdtempSync(path.join(tmpdir(), "restore-drill-"));
  const dst = path.join(tmp, "dev");
  const t0 = Date.now();
  cpSync(src, dst, { recursive: true }); // 备份=目录快照（生产=pg_dump，此处演练还原通路）
  const backupMs = Date.now() - t0;

  const t1 = Date.now();
  const db = new PGlite(dst);
  const tables = ["skus", "spus", "stock_ledger", "stock_balances", "stock_snapshots", "transit_refs", "review_items", "sales_monthly", "batch_stocks", "boms"];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await count(db, t);
  await db.close();
  const restoreMs = Date.now() - t1;
  rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: out.skus > 5000 && out.stock_ledger > 300, backupMs, verifyMs: restoreMs, counts: out }));
}
void main();
