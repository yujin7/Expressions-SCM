/**
 * D13 保质期一次性回填（须停 dev server 运行——PGlite 单进程）。
 *
 * 为什么需要这个脚本：放行引擎里已有回填（`release/engine.ts` releaseBatchStocks），
 * 但它走 `loadStagedRows`，而后者硬性只扫 `status ∈ (pending, validated)`。
 * 效期文件的 3131 行 batch_stock staging **早已全部 committed**，
 * 所以那段回填对存量数据**永远不会触发**——修的是「今后再导入」，不是「已经导入的」。
 * 实测后果：`skus.shelf_life_days` 全表 0/5376 非空，1026 个在售成品一个都没填上。
 *
 * 本脚本补的就是这一刀：直接读 committed 的 batch_stock staging payload，把保质期回填进主档。
 *
 * 纪律（与放行引擎内那段保持一致，口径不许分叉）：
 *  ① 只填空——`shelf_life_days IS NULL OR <= 0` 才写，绝不覆盖人工已设的值；
 *  ② 同一 SKU 在文件里出现互相矛盾的保质期 → 记 conflicted 并跳过，**不猜**；
 *  ③ 全程单事务 + writeAudit 留痕；
 *  ④ 默认 dry-run，必须显式 --commit 才写库。
 *
 * 运行：
 *   npx tsx scripts/backfill-shelf-life.ts            # 预演，零写入
 *   npx tsx scripts/backfill-shelf-life.ts --commit   # 实际写入
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { writeAudit } from "../src/server/core/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

interface Payload {
  skuCode?: string | null;
  shelfLifeDays?: number | null;
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const commit = process.argv.includes("--commit");
  const db: AnyDb = await getDbAsync();

  /* ── 读 committed 的 batch_stock staging（放行引擎够不着的那批） ── */
  const rows: { payload: unknown }[] = await db
    .select({ payload: schema.stagingRows.payload })
    .from(schema.stagingRows)
    .where(
      and(
        eq(schema.stagingRows.targetTable, "batch_stock"),
        inArray(schema.stagingRows.status, ["committed"]),
      ),
    );
  console.log(`committed batch_stock staging 行: ${rows.length}`);

  /* ── 按 skuCode 归集保质期，矛盾即记冲突（不猜） ── */
  const byCode = new Map<string, { days: number; conflict: boolean }>();
  let withShelf = 0;
  for (const r of rows) {
    const p = r.payload as Payload;
    const code = typeof p?.skuCode === "string" ? p.skuCode : null;
    const days = typeof p?.shelfLifeDays === "number" ? p.shelfLifeDays : null;
    if (!code || days == null || days <= 0) continue;
    withShelf++;
    const prev = byCode.get(code);
    if (!prev) byCode.set(code, { days, conflict: false });
    else if (prev.days !== days) prev.conflict = true;
  }
  const conflicted = [...byCode.entries()].filter(([, v]) => v.conflict).map(([c]) => c);
  const usable = [...byCode.entries()].filter(([, v]) => !v.conflict);
  console.log(`带保质期的行: ${withShelf}；去重后 SKU 编码: ${byCode.size}`);
  console.log(`口径矛盾跳过: ${conflicted.length}${conflicted.length ? ` → ${conflicted.slice(0, 5).join("、")}` : ""}`);

  /* ── 编码 → skuId（精确匹配；编码不存在的静默跳过并计数，不猜） ── */
  const codes = usable.map(([c]) => c);
  const skuRows: { id: number; code: string; shelf: number | null }[] = codes.length
    ? await db
        .select({ id: schema.skus.id, code: schema.skus.code, shelf: schema.skus.shelfLifeDays })
        .from(schema.skus)
        .where(inArray(schema.skus.code, codes))
    : [];
  const idByCode = new Map(skuRows.map((s) => [s.code, s]));
  const unmatched = codes.filter((c) => !idByCode.has(c));

  const targets = usable
    .map(([code, v]) => ({ sku: idByCode.get(code), days: v.days, code }))
    .filter((t): t is { sku: { id: number; code: string; shelf: number | null }; days: number; code: string } => t.sku != null)
    // 只填空：已有正值的一律不动（人工设定优先）
    .filter((t) => t.sku.shelf == null || t.sku.shelf <= 0);

  console.log(`编码未匹配到主档: ${unmatched.length}`);
  console.log(`待回填 SKU: ${targets.length}`);
  const dist = new Map<number, number>();
  for (const t of targets) dist.set(t.days, (dist.get(t.days) ?? 0) + 1);
  console.log("回填值分布:", [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5));

  if (!commit) {
    console.log("\n[dry-run] 零写入。确认无误后加 --commit 实际执行。");
    return;
  }

  await db.transaction(async (tx: AnyDb) => {
    let filled = 0;
    for (const t of targets) {
      const res = await tx
        .update(schema.skus)
        .set({ shelfLifeDays: t.days })
        .where(
          and(
            eq(schema.skus.id, t.sku.id),
            sql`(${schema.skus.shelfLifeDays} is null or ${schema.skus.shelfLifeDays} <= 0)`,
          ),
        )
        .returning({ id: schema.skus.id });
      filled += res.length;
    }
    await writeAudit(tx, {
      userId: 1,
      entity: "sku",
      action: "backfill_shelf_life",
      after: {
        source: "staging(batch_stock, committed)",
        scanned: rows.length,
        filled,
        conflicted: conflicted.length,
        unmatched: unmatched.length,
      },
    });
    console.log(`\n已回填 ${filled} 个 SKU 的 shelf_life_days（审计已留痕）。`);
  });
}

void main().then(() => process.exit(0));
