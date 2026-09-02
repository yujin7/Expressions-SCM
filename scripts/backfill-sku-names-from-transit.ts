/**
 * 用在途/盘点汇总源表里的品名回填「名称等于编码」的 SKU（管理员一次性运维入口）。
 *
 * 背景：2026-09-02 实测 104 个 SKU 的名称就是编码本身——它们由「销量汇总/在途订单」Excel
 * 建档，那两张表只有编码列。但同一批导入写进 transit_refs 的 `stock_summary` 行带完整品名
 * （公司格式 `(品牌)产品全称(规格)`），例如 A01-001 → (爱碧生)薰衣草按摩精油(100ml)。
 *
 * 规则（宁可少填不可填错）：
 *   - 只处理 name = code 的行；
 *   - 只采用 kind = 'stock_summary' 的品名（pallet 行是品牌缩写 "(ABS)"，物料行带 "彩盒-" 前缀，都不用）；
 *   - 同一编码若有多个不同的 stock_summary 品名，跳过并列出，交人裁决；
 *   - 逐条写审计（sku/update，附来源）。
 *
 * 用法：DATABASE_URL=postgres://… npx tsx scripts/backfill-sku-names-from-transit.ts [--apply]
 */
import { sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import { writeAudit } from "../src/server/core/audit";

const ADMIN_USER_ID = 1;

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDbAsync();
  const rows = (await db.execute(sql`
    with un as (select id, code from skus where name = code)
    select un.id, un.code,
           array_agg(distinct btrim(t.material_name)) as names
    from un join transit_refs t on t.sku_code = un.code and t.kind = 'stock_summary'
    where nullif(btrim(t.material_name), '') is not null and btrim(t.material_name) <> un.code
    group by un.id, un.code
    order by un.code`)).rows as { id: number; code: string; names: string[] }[];

  const unique = rows.filter((r) => r.names.length === 1);
  const ambiguous = rows.filter((r) => r.names.length > 1);
  const total = Number((await db.execute(sql`select count(*)::int n from skus where name = code`)).rows[0]!.n);

  console.log(`名称等于编码的 SKU：${total}；有唯一 stock_summary 品名：${unique.length}；有歧义：${ambiguous.length}`);
  for (const r of unique) console.log(`  ${r.code}  →  ${r.names[0]}`);
  if (ambiguous.length) {
    console.log("歧义（跳过，交人裁决）：");
    for (const r of ambiguous) console.log(`  ${r.code}  :  ${r.names.join(" | ")}`);
  }
  if (!apply) { console.log("（未应用，加 --apply 执行）"); return; }

  await db.transaction(async (tx) => {
    for (const r of unique) {
      const name = r.names[0]!;
      await tx.execute(sql`update skus set name = ${name}, updated_at = now() where id = ${r.id} and name = code`);
      await writeAudit(tx, {
        userId: ADMIN_USER_ID, entity: "sku", entityId: r.id, action: "update",
        before: { name: r.code },
        after: { name, reason: "名称曾等于编码；按 transit_refs(kind=stock_summary) 源表品名回填" },
      });
    }
  });
  console.log(`✓ 已回填 ${unique.length} 个，逐条写审计`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", (e as Error).message); process.exit(1); });
