import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import {
  buildDemandSummary,
  buildStockCoverageSummary,
} from "@/server/modules/report/transit-summary";

/** 在途参考层查询（D16 只读；kind=fg_order/pkg_order/pkg_stock/oem_map） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const kind = searchParams.get("kind") ?? "fg_order";
    const channel = searchParams.get("channel");
    const onlyRemark = searchParams.get("onlyRemark") === "1";
    const db = await getDbAsync();
    const t = schema.transitRefs;
    const conds = [eq(t.kind, kind)];
    if (kind === "demand" && channel) conds.push(eq(t.follower, channel));
    if (kind === "pallet" && onlyRemark) conds.push(isNotNull(t.exception));
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
    const includeSummary = searchParams.get("includeSummary") === "1";
    const [rows, [{ total }], [meta]] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.orderDate), desc(t.id)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ total: sql<number>`count(*)::int` }).from(t).where(where),
      db.select({ importedAt: sql<string | null>`max(${t.createdAt})` }).from(t).where(eq(t.kind, kind)),
    ]);

    /* E1-02：总库存核对的「系统数/差异」改为**查询时实时计算**——原先烘焙进 extra 的值
       会随库存变动而腐坏（PRD E1-02）。此处按当前实时账+最新快照现算并附加到行上。 */
    let enriched = rows as Record<string, unknown>[];
    let summary: Record<string, unknown> | null = null;
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

    if (includeSummary && kind === "demand") {
      const [totals, byChannel] = await Promise.all([
        db
          .select({
            rowCount: sql<number>`count(*)::int`,
            mappedRows: sql<number>`count(${t.skuId})::int`,
            demandQty: sql<string>`coalesce(sum(${t.qty}), 0)`,
            doneQty: sql<string>`coalesce(sum(${t.doneQty}), 0)`,
          })
          .from(t)
          .where(where),
        db
          .select({
            name: sql<string>`coalesce(${t.follower}, '未标渠道')`,
            demandQty: sql<string>`coalesce(sum(${t.qty}), 0)`,
            doneQty: sql<string>`coalesce(sum(${t.doneQty}), 0)`,
          })
          .from(t)
          .where(where)
          .groupBy(t.follower)
          .orderBy(sql`coalesce(sum(${t.qty}), 0) desc`),
      ]);
      summary = buildDemandSummary({
        rowCount: totals[0]?.rowCount ?? 0,
        mappedRows: totals[0]?.mappedRows ?? 0,
        demandQty: Number(totals[0]?.demandQty ?? 0),
        doneQty: Number(totals[0]?.doneQty ?? 0),
      }, byChannel.map((row) => ({
        name: row.name,
        demandQty: Number(row.demandQty ?? 0),
        doneQty: Number(row.doneQty ?? 0),
      })));
    }

    if (includeSummary && kind === "stock_summary") {
      const allRows: { skuId: number | null; qty: string | null }[] = await db
        .select({ skuId: t.skuId, qty: t.qty })
        .from(t)
        .where(where);
      const allSkuIds = [...new Set(allRows.map((row) => row.skuId).filter((id): id is number => id != null))];
      const systemQty = new Map<number, number>();
      if (allSkuIds.length > 0) {
        const s = schema.stockSnapshots;
        const [balanceRows, snapshotRows]: [
          { skuId: number; qty: string | null }[],
          { skuId: number; qty: string | null }[],
        ] = await Promise.all([
          db
            .select({
              skuId: schema.stockBalances.skuId,
              qty: sql<string | null>`sum(${schema.stockBalances.qty})`,
            })
            .from(schema.stockBalances)
            .where(inArray(schema.stockBalances.skuId, allSkuIds))
            .groupBy(schema.stockBalances.skuId),
          db
            .select({ skuId: s.skuId, qty: sql<string | null>`sum(${s.qty})` })
            .from(s)
            .innerJoin(
              db
                .select({
                  warehouseId: s.warehouseId,
                  skuId: s.skuId,
                  maxDate: sql<string>`max(${s.bizDate})`.as("max_date"),
                })
                .from(s)
                .where(inArray(s.skuId, allSkuIds))
                .groupBy(s.warehouseId, s.skuId)
                .as("latest"),
              sql`latest.warehouse_id = ${s.warehouseId} and latest.sku_id = ${s.skuId} and latest.max_date = ${s.bizDate}`,
            )
            .groupBy(s.skuId),
        ]);
        for (const row of balanceRows) systemQty.set(row.skuId, Number(row.qty ?? 0));
        for (const row of snapshotRows) {
          systemQty.set(row.skuId, (systemQty.get(row.skuId) ?? 0) + Number(row.qty ?? 0));
        }
      }
      summary = buildStockCoverageSummary(
        allRows.map((row) => ({ skuId: row.skuId, fileQty: Number(row.qty ?? 0) })),
        Object.fromEntries(systemQty),
      );
    }

    if (includeSummary && (kind === "pkg_order" || kind === "pkg_stock")) {
      const [coverage] = await db
        .select({
          materialRows: sql<number>`count(*) filter (where ${t.materialCode} is not null)::int`,
          linkedMaterialRows: sql<number>`count(${t.materialSkuId})::int`,
          distinctLinkedMaterials: sql<number>`count(distinct ${t.materialSkuId})::int`,
          unresolvedMaterialCodes:
            sql<number>`count(distinct ${t.materialCode}) filter (where ${t.materialCode} is not null and ${t.materialSkuId} is null)::int`,
          supplierRows:
            sql<number>`count(*) filter (where ${t.oemRaw} is not null and ${t.oemRaw} <> '/')::int`,
          linkedSupplierRows: sql<number>`count(${t.supplierId})::int`,
        })
        .from(t)
        .where(eq(t.kind, kind));
      summary = {
        type: "material_coverage",
        materialRows: coverage?.materialRows ?? 0,
        linkedMaterialRows: coverage?.linkedMaterialRows ?? 0,
        distinctLinkedMaterials: coverage?.distinctLinkedMaterials ?? 0,
        unresolvedMaterialCodes: coverage?.unresolvedMaterialCodes ?? 0,
        supplierRows: coverage?.supplierRows ?? 0,
        linkedSupplierRows: coverage?.linkedSupplierRows ?? 0,
      };
    }

    return NextResponse.json({ rows: enriched, total, importedAt: meta?.importedAt ?? null, summary });
  } catch (e) {
    return errorResponse(e);
  }
}
