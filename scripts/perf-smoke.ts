/**
 * 性能冒烟（DoD-5 的开发级前哨；正式压测在 staging 真 PG 上按 100 万行执行）。
 * 运行：npx tsx scripts/perf-smoke.ts [行数=100000]
 * 独立 PGlite 实例，不触碰开发库。
 */
import { createTestDb } from "../tests/helpers/db";
import * as schema from "../src/db/schema";
import { sql } from "drizzle-orm";
import { listBalances, listLedger } from "../src/server/modules/inventory/queries";

async function main() {
  const N = Number(process.argv[2] ?? 100_000);
  const { db } = await createTestDb();
  const [spu] = await db.insert(schema.spus).values({ code: "P90000", nameCn: "压测品" }).returning();
  const skuIds: number[] = [];
  for (let i = 0; i < 50; i++) {
    const [s] = await db
      .insert(schema.skus)
      .values({ code: `PT${String(i).padStart(4, "0")}`, name: `压测SKU${i}`, spuId: spu.id, baseUom: "个", skuType: "finished" })
      .returning();
    skuIds.push(s.id);
  }
  const whIds: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [w] = await db.insert(schema.warehouses).values({ code: `PW${i}`, name: `压测仓${i}`, kind: "finished" }).returning();
    whIds.push(w.id);
  }
  const t0 = Date.now();
  for (let batch = 0; batch < Math.ceil(N / 2000); batch++) {
    const rows = [];
    for (let i = 0; i < 2000 && batch * 2000 + i < N; i++) {
      const n = batch * 2000 + i;
      rows.push({
        skuId: skuIds[n % 50],
        warehouseId: whIds[n % 4],
        qtyDelta: n % 2 === 0 ? "5.0000" : "-3.0000",
        sourceDocType: "sales_out",
        sourceDocId: n + 1,
        sourceLineId: 0,
        action: "post",
        occurredAt: new Date(Date.UTC(2026, 0, 1 + (n % 180))),
      });
    }
    await db.insert(schema.stockLedger).values(rows);
  }
  console.log(`seed ${N} ledger rows: ${Date.now() - t0}ms`);
  const balRows = [] as (typeof schema.stockBalances.$inferInsert)[];
  for (const s of skuIds) for (const w of whIds) balRows.push({ skuId: s, warehouseId: w, batchId: null, qty: "1000.0000" });
  await db.insert(schema.stockBalances).values(balRows);

  const time = async (label: string, fn: () => Promise<unknown>) => {
    await fn();
    const ts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const a = Date.now();
      await fn();
      ts.push(Date.now() - a);
    }
    ts.sort((x, y) => x - y);
    console.log(`${label}: median ${ts[2]}ms (min ${ts[0]} max ${ts[4]})`);
  };

  await time("余额查询(分页20)", () => listBalances({ page: 1, pageSize: 20, nonzero: true }, db));
  await time("流水查询(单SKU单仓,分页20)", () => listLedger({ skuId: skuIds[0], warehouseId: whIds[0], page: 1, pageSize: 20 }, db));
  await time("流水查询(全量分页20)", () => listLedger({ page: 1, pageSize: 20 }, db));
  await time("对账口径聚合(单日 sales_out 按SKU汇总)", () =>
    db
      .select({ skuId: schema.stockLedger.skuId, s: sql`sum(${schema.stockLedger.qtyDelta})` })
      .from(schema.stockLedger)
      .where(sql`${schema.stockLedger.action} = 'post' AND ${schema.stockLedger.occurredAt} >= '2026-01-10' AND ${schema.stockLedger.occurredAt} < '2026-01-11'`)
      .groupBy(schema.stockLedger.skuId),
  );
}

void main();
