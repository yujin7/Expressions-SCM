/** NPD 三件套 + 总库存汇总 入库与核对（须停 dev server） */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { stageNpd } from "../src/server/import/adapters/npd";
import { stageStockSummary } from "../src/server/import/adapters/stock-summary";
import { releaseTransitRefs, type ReleaseUser } from "../src/server/modules/release/engine";

const D = "/Users/yj/Desktop/SCM";

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  const admin: ReleaseUser = { id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover };

  // 0) 电商部库存明细 身份核验（应=既有期初/快照来源）
  const dsHash = createHash("md5").update(readFileSync(`${D}/电商部库存明细26-7-21.xlsx`)).digest("hex");
  const jobs = await db.select({ id: schema.importJobs.id, template: schema.importJobs.template, status: schema.importJobs.status })
    .from(schema.importJobs).where(eq(schema.importJobs.fileHash, dsHash));
  console.log("电商部库存明细 身份:", jobs.length ? jobs.map((j) => `#${j.id}:${j.template}/${j.status}`).join(" ") : "❌ 无记录");

  // 1) NPD 三件套
  const npd = await stageNpd(db, {
    base: `${D}/各节点核心说明_数据表.xlsx`,
    sim: `${D}/各节点核心说明_数据表_常规新品开发时间节点模拟.xlsx`,
    withRoles: `${D}/各节点核心说明.xlsx`,
  }, admin.id);
  console.log("NPD staging:", JSON.stringify(npd.stats));

  // 2) 总库存汇总
  const ss = await stageStockSummary(db, `${D}/总库存明细2026-7-21.xlsx`, admin.id);
  console.log("总库存 staging:", JSON.stringify(ss.stats));

  // 3) 放行（整类替换）
  const rel = await releaseTransitRefs(admin, { dryRun: false });
  console.log("release:", JSON.stringify({ byKind: rel.byKind, skuResolved: rel.skuResolved, skuUnresolved: rel.skuUnresolved }));

  // 4) 交叉核对：总库存.商品数量 vs 系统全网口径（实时+最新快照）
  const sys = await db.execute(sql`
    with rt as (select sku_id, sum(qty) q from stock_balances group by 1),
    sn as (select s.sku_id, sum(s.qty) q from stock_snapshots s
           join (select warehouse_id, sku_id, max(biz_date) d from stock_snapshots group by 1,2) m
             on m.warehouse_id=s.warehouse_id and m.sku_id=s.sku_id and m.d=s.biz_date group by 1)
    select t.sku_code, t.qty::numeric as file_qty,
           coalesce(rt.q,0)+coalesce(sn.q,0) as sys_qty
    from transit_refs t
    left join rt on rt.sku_id = t.sku_id
    left join sn on sn.sku_id = t.sku_id
    where t.kind='stock_summary' and t.sku_id is not null`);
  const rows = (sys as unknown as { rows: { sku_code: string; file_qty: string; sys_qty: string }[] }).rows;
  let match = 0; const diffs: { sku: string; file: number; sys: number; d: number }[] = [];
  for (const r of rows) {
    const f = Number(r.file_qty ?? 0), s2 = Number(r.sys_qty ?? 0);
    if (Math.abs(f - s2) < 0.5) match++;
    else diffs.push({ sku: r.sku_code, file: f, sys: s2, d: s2 - f });
  }
  diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`交叉核对: ${rows.length} SKU 可比 | 一致 ${match} | 差异 ${diffs.length}`);
  console.log("TOP 差异:", JSON.stringify(diffs.slice(0, 8)));
  writeFileSync("reports/总库存核对-2026-07-21.json", JSON.stringify({ comparable: rows.length, match, diffs }, null, 2));
  console.log("差异全量 → reports/总库存核对-2026-07-21.json");
}
void main();
