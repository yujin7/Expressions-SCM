import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";

/**
 * 仓库 360（0724 会议：单仓维度全链路查询）。
 * 实时仓：余额 TOP + 近 10 条流水；快照仓：最新快照 TOP + 快照期数；两者：在此仓的近效期批次。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id: idStr } = await ctx.params;
    const id = parseId(idStr);
    const db = await getDbAsync();
    const [wh] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.id, id));
    if (!wh) return NextResponse.json({ error: "仓库不存在" }, { status: 404 });

    const isRealtime = wh.accountingMode === "realtime";
    const topStock: unknown[] = isRealtime
      ? await db
          .select({
            skuCode: schema.skus.code, skuName: schema.skus.name, baseUom: schema.skus.baseUom,
            qty: sql<string>`sum(${schema.stockBalances.qty})`,
          })
          .from(schema.stockBalances)
          .innerJoin(schema.skus, eq(schema.stockBalances.skuId, schema.skus.id))
          .where(eq(schema.stockBalances.warehouseId, id))
          .groupBy(schema.skus.code, schema.skus.name, schema.skus.baseUom)
          .having(sql`sum(${schema.stockBalances.qty}) <> 0`)
          .orderBy(sql`sum(${schema.stockBalances.qty}) desc`)
          .limit(20)
      : await db
          .select({
            skuCode: schema.skus.code, skuName: schema.skus.name, baseUom: schema.skus.baseUom,
            qty: schema.stockSnapshots.qty, bizDate: schema.stockSnapshots.bizDate,
          })
          .from(schema.stockSnapshots)
          .innerJoin(schema.skus, eq(schema.stockSnapshots.skuId, schema.skus.id))
          // 口径：逐 (仓, SKU) 取各自最新期，与 core/stock-view 一致。
          // 原先取「本仓最新期」——某 SKU 在新一期文件里缺行（渠道断货/下架就会发生）
          // 会整条消失、页面显示 0，而全网在库（驾驶舱/补货/风险）仍按它上一期的数计入：
          // 同一批货两个页面一个有一个没有，且错的那边正是仓库负责人核对用的页面。
          .where(and(eq(schema.stockSnapshots.warehouseId, id),
            sql`(${schema.stockSnapshots.skuId}, ${schema.stockSnapshots.bizDate}) in (
                  select s2.sku_id, max(s2.biz_date) from stock_snapshots s2
                  where s2.warehouse_id = ${id} group by s2.sku_id)`))
          .orderBy(desc(schema.stockSnapshots.qty))
          .limit(20);

    const [totals] = isRealtime
      ? await db.select({ total: sql<string>`coalesce(sum(${schema.stockBalances.qty}),'0')`, skuCount: sql<number>`count(distinct ${schema.stockBalances.skuId})::int` })
          .from(schema.stockBalances).where(and(eq(schema.stockBalances.warehouseId, id), sql`${schema.stockBalances.qty} <> 0`))
      : await db.select({ total: sql<string>`coalesce(sum(q.qty),'0')`, skuCount: sql<number>`count(*)::int` })
          .from(sql`(select s.qty from stock_snapshots s
                     where s.warehouse_id = ${id}
                       and (s.sku_id, s.biz_date) in (
                         select s2.sku_id, max(s2.biz_date) from stock_snapshots s2
                         where s2.warehouse_id = ${id} group by s2.sku_id)) q`);

    const recentLedger = isRealtime
      ? await db
          .select({
            occurredAt: schema.stockLedger.occurredAt, skuCode: schema.skus.code,
            qtyDelta: schema.stockLedger.qtyDelta, sourceDocType: schema.stockLedger.sourceDocType,
          })
          .from(schema.stockLedger)
          .innerJoin(schema.skus, eq(schema.stockLedger.skuId, schema.skus.id))
          .where(eq(schema.stockLedger.warehouseId, id))
          .orderBy(desc(schema.stockLedger.occurredAt), desc(schema.stockLedger.id))
          .limit(10)
      : [];

    const batches = await db
      .select({
        skuCode: schema.skus.code, expiryDate: schema.batchStocks.expiryDate, qty: schema.batchStocks.qty,
      })
      .from(schema.batchStocks)
      .innerJoin(schema.skus, eq(schema.batchStocks.skuId, schema.skus.id))
      .where(and(eq(schema.batchStocks.warehouseId, id), sql`${schema.batchStocks.expiryDate} is not null`, sql`${schema.batchStocks.qty} > 0`))
      .orderBy(schema.batchStocks.expiryDate)
      .limit(10);

    const snapDates = isRealtime
      ? []
      : await db
          .select({ bizDate: schema.stockSnapshots.bizDate, total: sql<string>`sum(${schema.stockSnapshots.qty})` })
          .from(schema.stockSnapshots)
          .where(eq(schema.stockSnapshots.warehouseId, id))
          .groupBy(schema.stockSnapshots.bizDate)
          .orderBy(desc(schema.stockSnapshots.bizDate))
          .limit(6);

    return NextResponse.json({
      warehouse: {
        id: wh.id,
        code: wh.code,
        name: wh.name,
        kind: wh.kind,
        accountingMode: wh.accountingMode,
        regionCode: wh.regionCode,
      },
      totals, topStock, recentLedger, batches, snapDates,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
