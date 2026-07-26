import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";

/** 在途参考层查询（D16 只读；kind=fg_order/pkg_order/pkg_stock/oem_map） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const kind = searchParams.get("kind") ?? "fg_order";
    const db = await getDbAsync();
    const t = schema.transitRefs;
    const conds = [eq(t.kind, kind)];
    if (q) {
      conds.push(
        or(
          ilike(t.skuCode, `%${q}%`),
          ilike(t.materialCode, `%${q}%`),
          ilike(t.materialName, `%${q}%`),
          ilike(t.approvalNo, `%${q}%`),
          ilike(t.externalNo, `%${q}%`),
        )!,
      );
    }
    const where = and(...conds);
    const [rows, [{ total }], [meta]] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.orderDate), desc(t.id)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ total: sql<number>`count(*)::int` }).from(t).where(where),
      db.select({ importedAt: sql<string | null>`max(${t.createdAt})` }).from(t).where(eq(t.kind, kind)),
    ]);

    /* E1-02：总库存核对的「系统数/差异」改为**查询时实时计算**——原先烘焙进 extra 的值
       会随库存变动而腐坏（PRD E1-02）。此处按当前实时账+最新快照现算并附加到行上。 */
    let enriched = rows as Record<string, unknown>[];
    if (kind === "stock_summary" && rows.length > 0) {
      const skuIds = (rows as { skuId: number | null }[]).map((r) => r.skuId).filter((v): v is number => v != null);
      const sysBySku = new Map<number, number>();
      if (skuIds.length > 0) {
        const s = schema.stockSnapshots;
        const [balRows, snapRows]: [{ skuId: number; qty: string | null }[], { skuId: number; qty: string | null }[]] =
          await Promise.all([
            db
              .select({ skuId: schema.stockBalances.skuId, qty: sql<string | null>`sum(${schema.stockBalances.qty})` })
              .from(schema.stockBalances)
              .where(inArray(schema.stockBalances.skuId, skuIds))
              .groupBy(schema.stockBalances.skuId),
            db
              .select({ skuId: s.skuId, qty: sql<string | null>`sum(${s.qty})` })
              .from(s)
              .innerJoin(
                db
                  .select({ warehouseId: s.warehouseId, skuId: s.skuId, maxDate: sql<string>`max(${s.bizDate})`.as("max_date") })
                  .from(s)
                  .where(inArray(s.skuId, skuIds))
                  .groupBy(s.warehouseId, s.skuId)
                  .as("latest"),
                sql`latest.warehouse_id = ${s.warehouseId} and latest.sku_id = ${s.skuId} and latest.max_date = ${s.bizDate}`,
              )
              .groupBy(s.skuId),
          ]);
        for (const r of balRows) sysBySku.set(r.skuId, Number(r.qty ?? 0));
        for (const r of snapRows) sysBySku.set(r.skuId, (sysBySku.get(r.skuId) ?? 0) + Number(r.qty ?? 0));
      }
      enriched = (rows as unknown as { skuId: number | null; qty: string | null; extra: Record<string, unknown> | null }[]).map((r) => {
        const sys = r.skuId == null ? null : (sysBySku.get(r.skuId) ?? 0);
        const file = Number(r.qty ?? 0);
        return {
          ...r,
          sysQty: sys,
          diffQty: sys == null ? null : Math.round((sys - file) * 10000) / 10000,
        } as Record<string, unknown>;
      });
    }
    return NextResponse.json({ rows: enriched, total, importedAt: meta?.importedAt ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}
