/**
 * 复核清单落库：解析 reports/复核清单-2026-07-24.md → review_items。
 * 幂等：同 title 已存在则跳过（可重复执行）。
 *
 * 运行（dev server 必须停止——PGlite 单进程独占 .data/dev）：
 *   npx tsx scripts/seed-review-items.ts [md路径]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { parseReviewMarkdown } from "../src/server/modules/review/parse";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const mdPath = process.argv[2] ?? path.resolve(process.cwd(), "reports/复核清单-2026-07-24.md");
  const md = readFileSync(mdPath, "utf8");
  const items = parseReviewMarkdown(md);
  console.log(`解析 ${mdPath}：${items.length} 条（已按 title 去重）`);

  const db = await getDbAsync();
  // 幂等：分批查已存在 title
  const existing = new Set<string>();
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500).map((x) => x.title);
    const rows = await db
      .select({ title: schema.reviewItems.title })
      .from(schema.reviewItems)
      .where(inArray(schema.reviewItems.title, chunk));
    for (const r of rows) existing.add(r.title);
  }
  const fresh = items.filter((x) => !existing.has(x.title));
  for (let i = 0; i < fresh.length; i += 500) {
    await db.insert(schema.reviewItems).values(
      fresh.slice(i, i + 500).map((x) => ({
        category: x.category,
        refType: x.refType,
        refKey: x.refKey,
        title: x.title,
        detail: x.detail,
      })),
    );
  }
  const byCat = new Map<string, number>();
  for (const x of fresh) byCat.set(x.category, (byCat.get(x.category) ?? 0) + 1);
  console.log(`新增 ${fresh.length} 条，跳过已存在 ${existing.size} 条`);
  for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${cat}: ${n}`);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
