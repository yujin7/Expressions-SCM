/**
 * 只给**名称为空**的 SKU 补名（管理员一次性运维入口）。
 *
 * 2026-09-02 实测两个成品名称为空串（E030-000、N031-X-001），列表与单据里显示成空白。
 * 名称按同 SPU 下物料/版本的命名一致推导（公司标准 `(品牌)产品全称(规格)+后缀`），
 * 只允许写入当前为空的行——已有名称一律拒绝，避免被误用成批量改名工具。逐条写审计。
 *
 * 用法：DATABASE_URL=postgres://… npx tsx scripts/fill-blank-sku-name.ts <编码> "<名称>" [--apply]
 */
import { sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import { writeAudit } from "../src/server/core/audit";

const ADMIN_USER_ID = 1;

async function main() {
  const [code, name, flag] = process.argv.slice(2);
  if (!code || !name?.trim()) throw new Error("用法: fill-blank-sku-name.ts <编码> \"<名称>\" [--apply]");
  const db = await getDbAsync();
  const rows = (await db.execute(sql`select id, code, name from skus where code = ${code}`)).rows as
    { id: number; code: string; name: string }[];
  if (rows.length !== 1) throw new Error(`编码 ${code} 匹配 ${rows.length} 行`);
  const sku = rows[0];
  if (sku.name.trim() !== "") throw new Error(`SKU ${code} 已有名称「${sku.name}」，本工具只补空名`);
  console.log(`SKU #${sku.id} ${sku.code}: "" → ${name}`);
  if (flag !== "--apply") { console.log("  检查通过（未应用，加 --apply 执行）"); return; }
  await db.transaction(async (tx) => {
    await tx.execute(sql`update skus set name = ${name.trim()}, updated_at = now() where id = ${sku.id} and btrim(name) = ''`);
    await writeAudit(tx, {
      userId: ADMIN_USER_ID, entity: "sku", entityId: sku.id, action: "update",
      before: { name: "" }, after: { name: name.trim(), reason: "导入遗留空名，按同 SPU 命名规则补齐" },
    });
  });
  console.log("  ✓ 已补名并写审计");
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", (e as Error).message); process.exit(1); });
