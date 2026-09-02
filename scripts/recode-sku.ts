/**
 * 纠正**没有任何历史关联**的 SKU 主码（管理员一次性运维入口）。
 *
 * 为什么不走 updateSku：服务层刻意禁止改主码——主码一旦进入库存账、单据、标识与外部映射，
 * 改码等于篡改历史。但导入事故会留下"从未被用过"的坏码（2026-07-23 BOM 导入把数字列当编码，
 * 生成了 `0` 与 `76` 两个物料），这类行只被 BOM 按 id 引用，改码不影响任何历史事实。
 * 本脚本先证明"零历史"再改，任一引用存在即拒绝；变更逐条写审计，可按审计回滚。
 *
 * 用法：DATABASE_URL=postgres://… npx tsx scripts/recode-sku.ts <旧码> <新码> [--apply]
 * 不带 --apply 只做检查。
 */
import { sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import { writeAudit } from "../src/server/core/audit";

const ADMIN_USER_ID = 1;
const CODE_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*(\([0-9]+\))?$/;

async function main() {
  const [oldCode, newCode, flag] = process.argv.slice(2);
  if (!oldCode || !newCode) throw new Error("用法: recode-sku.ts <旧码> <新码> [--apply]");
  if (!CODE_RE.test(newCode)) throw new Error(`新码不符合编码形态: ${newCode}`);
  const apply = flag === "--apply";
  const db = await getDbAsync();

  const skuRows = (await db.execute(sql`select id, code, name from skus where code = ${oldCode}`)).rows as
    { id: number; code: string; name: string }[];
  if (skuRows.length !== 1) throw new Error(`旧码 ${oldCode} 匹配 ${skuRows.length} 行，必须恰好 1 行`);
  const sku = skuRows[0];

  const taken = (await db.execute(sql`
    select 'skus' src from skus where code = ${newCode}
    union all select 'sku_identifiers' from sku_identifiers where value = ${newCode}`)).rows;
  if (taken.length) throw new Error(`新码 ${newCode} 已被占用: ${JSON.stringify(taken)}`);

  // 动态枚举所有指向 skus 的列（除 BOM 行外一律视为历史关联）
  const cols = (await db.execute(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and column_name in ('sku_id','material_sku_id','substitute_sku_id','product_sku_id','finished_sku_id','component_sku_id')
      and table_name not in ('skus')`)).rows as { table_name: string; column_name: string }[];
  const refs: string[] = [];
  for (const c of cols) {
    const r = (await db.execute(sql.raw(
      `select count(*)::int n from "${c.table_name}" where "${c.column_name}" = ${sku.id}`,
    ))).rows[0] as { n: number };
    if (r.n > 0) refs.push(`${c.table_name}.${c.column_name}=${r.n}`);
  }
  // 草稿单据还没形成事实（未过账、无账页、可随时删改），它按 id 引用 SKU，改码不会篡改任何历史；
  // 只有已提交/已过账的单据行才是历史关联。draft 之外一律阻断。
  const nonDraftDocLines = (await db.execute(sql`
    select count(*)::int n from stock_doc_lines l join stock_docs d on d.id = l.stock_doc_id
    where l.sku_id = ${sku.id} and d.status <> 'draft'`)).rows[0] as { n: number };
  const blocking = refs.filter((r) => !r.startsWith("bom_lines.") && !r.startsWith("stock_doc_lines."));
  if (nonDraftDocLines.n > 0) blocking.push(`stock_doc_lines(非草稿)=${nonDraftDocLines.n}`);
  console.log(`SKU #${sku.id} ${sku.code} → ${newCode}\n  名称: ${sku.name}\n  引用: ${refs.join(", ") || "无"}`);
  if (blocking.length) throw new Error(`存在历史关联，拒绝改码: ${blocking.join(", ")}`);
  if (!apply) { console.log("  检查通过（未应用，加 --apply 执行）"); return; }

  await db.transaction(async (tx) => {
    await tx.execute(sql`update skus set code = ${newCode}, updated_at = now() where id = ${sku.id} and code = ${oldCode}`);
    await writeAudit(tx, {
      userId: ADMIN_USER_ID, entity: "sku", entityId: sku.id, action: "recode",
      before: { code: oldCode }, after: { code: newCode, reason: "导入事故产生的无历史坏码纠正", refs },
    });
  });
  console.log("  ✓ 已改码并写审计");
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", (e as Error).message); process.exit(1); });
