/** 三文件入库核验：身份(hash)×行数对账×重复检查×消费方在位 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";

const FILES = {
  expiry: {
    path: "/Users/yj/Desktop/SCM/7月电商组效期占比情况-仅数量.xlsx",
    templates: ["expiry_batch_202607"],
  },
  sales: {
    path: "/Users/yj/Desktop/SCM/26年产品销量汇总（6月）.xlsx",
    // 同一物理文件有两个合法消费方，不属于重复导入。
    templates: ["sales_monthly_summary", "sku_leadtime"],
  },
  transit: {
    path: "/Users/yj/Desktop/SCM/2026年成品在途订单实时进度表---新版.xlsx",
    templates: ["transit", "sku_leadtime"],
  },
};

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const md5 = (p: string) => createHash("md5").update(readFileSync(p)).digest("hex");
  const hashes = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, md5(v.path)]));

  // 1) 身份：import_jobs 里这些 hash 的记录
  const jobs = await db
    .select({ id: schema.importJobs.id, template: schema.importJobs.template, filename: schema.importJobs.filename,
      fileHash: schema.importJobs.fileHash, status: schema.importJobs.status })
    .from(schema.importJobs)
    .orderBy(schema.importJobs.id);
  console.log("== 身份核验 ==");
  for (const [k, h] of Object.entries(hashes)) {
    const hit = jobs.filter((j) => j.fileHash === h);
    const expected = new Set(FILES[k as keyof typeof FILES].templates);
    const legitimate = hit.filter((j) => expected.has(j.template));
    const unexpected = hit.filter((j) => !expected.has(j.template));
    console.log(
      `${k}: hash=${h.slice(0, 8)}… → 合法模板记录 ${legitimate.length} 次`,
      legitimate.map((j) => `#${j.id}:${j.template}/${j.status}`).join(" "),
    );
    if (unexpected.length > 0) {
      console.log("  ⚠ 非预期模板:", unexpected.map((j) => `#${j.id}:${j.template}/${j.status}`).join(" "));
    }
  }
  // 重复键必须按 (template, hash) 判断；只按 hash 会把“同文件多用途”误报成重复。
  const byHash = new Map<string, typeof jobs>();
  for (const j of jobs) {
    if (!j.fileHash) continue;
    const key = `${j.template}\0${j.fileHash}`;
    const a = byHash.get(key) ?? [];
    a.push(j);
    byHash.set(key, a);
  }
  const dupHash = [...byHash.values()].filter((a) => a.length > 1);
  const duplicateActive = dupHash.filter((group) => group.filter((j) => j.status !== "superseded").length > 1);
  console.log(
    "重复 (template,hash) 组:",
    dupHash.length,
    "| 多个未 superseded 版本:",
    duplicateActive.length,
  );
  // superseded 组内残留 pending 行
  const supersededIds = jobs.filter((j) => j.status === "superseded").map((j) => j.id);
  const [orphan] = supersededIds.length
    ? await db.select({ c: sql<number>`count(*)::int` }).from(schema.stagingRows)
        .where(and(inArray(schema.stagingRows.importJobId, supersededIds), inArray(schema.stagingRows.status, ["pending", "validated"])))
    : [{ c: 0 }];
  console.log("superseded 作业残留待放行行:", orphan.c);

  // 2) 效期对账
  console.log("\n== 效期（batch_stocks）==");
  const [b] = await db.select({
    rows: sql<number>`count(*)::int`,
    qty: sql<string>`coalesce(sum(${schema.batchStocks.qty}),'0')`,
    skus: sql<number>`count(distinct ${schema.batchStocks.skuId})::int`,
    whs: sql<number>`count(distinct ${schema.batchStocks.warehouseId})::int`,
  }).from(schema.batchStocks);
  const [bstage] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.stagingRows)
    .where(and(eq(schema.stagingRows.targetTable, "batch_stock"), eq(schema.stagingRows.status, "committed")));
  // 自然键重复=0（约束在，但显式验证）
  const dupB = await db.execute(sql`select count(*)::int as c from (select sku_id,warehouse_id,stocktake_date,prod_date,expiry_date,batch_no,count(*) from batch_stocks group by 1,2,3,4,5,6 having count(*)>1) t`);
  console.log(`物理行 ${b.rows}（源行 committed ${bstage.c}——同键合并所致）| 数量合计 ${b.qty} | SKU ${b.skus} | 仓 ${b.whs} | 自然键重复组 ${(dupB as unknown as { rows: { c: number }[] }).rows[0].c}`);

  // 3) 销量对账
  console.log("\n== 销量（sales_monthly）==");
  const [s] = await db.select({
    rows: sql<number>`count(*)::int`,
    qty: sql<string>`coalesce(sum(${schema.salesMonthly.qty}),'0')`,
    months: sql<number>`count(distinct ${schema.salesMonthly.yearMonth})::int`,
    skus: sql<number>`count(distinct ${schema.salesMonthly.skuId})::int`,
    chans: sql<number>`count(distinct ${schema.salesMonthly.channelId})::int`,
  }).from(schema.salesMonthly);
  console.log(`键行 ${s.rows} | 总量 ${s.qty}（修复后基准 3,510,985）| 月 ${s.months} | SKU ${s.skus} | 渠道 ${s.chans}`);

  // 4) 在途对账
  console.log("\n== 在途（transit_refs）==");
  const tr = await db.select({
    kind: schema.transitRefs.kind,
    c: sql<number>`count(*)::int`,
    jobs: sql<number>`count(distinct ${schema.transitRefs.sourceJobId})::int`,
  }).from(schema.transitRefs).groupBy(schema.transitRefs.kind).orderBy(schema.transitRefs.kind);
  for (const r of tr) console.log(`  ${r.kind}: ${r.c} 行（来源作业数 ${r.jobs}——应=1，整类替换证明）`);
  const [moq] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.uomConvs).where(isNotNull(schema.uomConvs.moq));
  console.log(`uom_convs 带 MOQ: ${moq.c}（在途文件起订量注入）`);

  // 5) 消费方在位（直查=驾驶舱/补货口径同源）
  console.log("\n== 消费方 ==");
  const [risk] = await db.select({ q: sql<string>`coalesce(sum(qty),'0')` }).from(schema.batchStocks)
    .where(sql`expiry_date is not null and qty > 0 and expiry_date <= (current_date + interval '183 days')`);
  console.log(`效期→驾驶舱风险口径(≤183天)可算: ${risk.q}`);
  const [trend] = await db.select({ q: sql<string>`coalesce(sum(qty),'0')` }).from(schema.salesMonthly).where(eq(schema.salesMonthly.yearMonth, "2026-06"));
  console.log(`销量→6月总量(驾驶舱 KPI 源): ${trend.q}`);
  const [fg] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.transitRefs)
    .where(and(eq(schema.transitRefs.kind, "fg_order"), isNotNull(schema.transitRefs.skuId)));
  console.log(`在途→成品行 SKU 已解析: ${fg.c}/664`);
}
void main();
