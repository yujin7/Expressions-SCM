/**
 * SKU 360° 全景追溯（只读聚合）。
 *
 * 口径纪律：
 * - 仅数量维度，不出任何金额/单价字段（R9：路由层仍过 maskSensitive 双保险）；
 * - 实时账 = stock_balances；快照仓 = 最新 stock_snapshots（带 bizDate 数据龄）；
 * - 效期 = batch_stocks 参考层（非账本，1.0 口径）；
 * - 展示层聚合允许 Number()（非记账路径）；
 * - 批量查询拼装，无 N+1（流水单号解析按来源表分组补查，≤6 次小查询）。
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError, todayShanghai } from "./common";
import { lastMonths } from "@/server/core/velocity";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface SkuPanorama {
  sku: {
    id: number;
    code: string;
    name: string;
    spec: string | null;
    version: string | null;
    baseUom: string;
    skuType: string;
    lifecycle: string;
    active: boolean;
    attrs: unknown;
    brandName: string | null;
    spuCode: string;
    spuName: string;
  };
  balances: { warehouseId: number; warehouseName: string; warehouseKind: string; qty: string }[];
  snapshots: { warehouseId: number; warehouseName: string; bizDate: string; qty: string; ageDays: number }[];
  batches: {
    warehouseName: string;
    batchNo: string | null;
    prodDate: string | null;
    expiryDate: string;
    daysLeft: number;
    qty: string;
  }[];
  sales: {
    months: string[];
    byMonth: { month: string; qty: number }[];
    topChannels: { name: string; qty: number }[];
  };
  openDocs: {
    poLines: {
      poId: number;
      docNo: string;
      status: string;
      supplierName: string;
      expectedDate: string | null;
      openQty: string;
    }[];
    woDocs: { woId: number; docNo: string; status: string; supplierName: string; qty: string; dueDate: string | null }[];
  };
  ledger: {
    id: number;
    occurredAt: string;
    sourceDocType: string;
    docNo: string | null;
    warehouseName: string;
    qtyDelta: string;
    action: string;
  }[];
  activeBom: { id: number; versionNo: string; lineCount: number } | null;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** 流水来源类型 → 单据表（docNo 解析用；未列出的子类型默认 stock_doc 载体） */
const LEDGER_SOURCE_TABLE: Record<string, "sh" | "fl" | "tl" | "ct" | "js"> = {
  sh_purchase_in: "sh",
  sh_outsource_in: "sh",
  spare_in: "sh",
  fl_issue: "fl",
  tl_return: "tl",
  ct_return: "ct",
  js_loss_writeoff: "js",
};


export async function getSkuPanorama(id: number, dbArg?: AnyDb): Promise<SkuPanorama> {
  const db: AnyDb = dbArg ?? (await getDbAsync());

  const [skuRow]: {
    id: number;
    code: string;
    name: string;
    spec: string | null;
    version: string | null;
    baseUom: string;
    skuType: string;
    lifecycle: string;
    active: boolean;
    attrs: unknown;
    brandName: string | null;
    spuCode: string;
    spuName: string;
  }[] = await db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      spec: schema.skus.spec,
      version: schema.skus.version,
      baseUom: schema.skus.baseUom,
      skuType: schema.skus.skuType,
      lifecycle: schema.skus.lifecycle,
      active: schema.skus.active,
      attrs: schema.skus.attrs,
      brandName: schema.brands.nameCn,
      spuCode: schema.spus.code,
      spuName: schema.spus.nameCn,
    })
    .from(schema.skus)
    .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(eq(schema.skus.id, id));
  if (!skuRow) throw new ApiError(404, "SKU 不存在");

  const s = schema.stockSnapshots;
  const latest = db
    .select({
      warehouseId: s.warehouseId,
      skuId: s.skuId,
      maxDate: sql<string>`max(${s.bizDate})`.as("max_date"),
    })
    .from(s)
    .where(eq(s.skuId, id))
    .groupBy(s.warehouseId, s.skuId)
    .as("latest");

  const sm = schema.salesMonthly;
  const today = todayShanghai();
  const todayMs = new Date(`${today}T00:00:00+08:00`).getTime();

  const [balances, snapRows, batchRows, salesRows, poLineRows, woRows, ledgerRows, bomRow]: [
    { warehouseId: number; warehouseName: string; warehouseKind: string; qty: string }[],
    { warehouseId: number; warehouseName: string; bizDate: string; qty: string }[],
    { warehouseName: string; batchNo: string | null; prodDate: string | null; expiryDate: string; qty: string }[],
    { month: string; channelName: string; qty: string }[],
    { poId: number; docNo: string; status: string; supplierName: string; expectedDate: string | null; openQty: string }[],
    { woId: number; docNo: string; status: string; supplierName: string; qty: string; dueDate: string | null }[],
    { id: number; occurredAt: Date; sourceDocType: string; sourceDocId: number; warehouseName: string; qtyDelta: string; action: string }[],
    { id: number; versionNo: string; lineCount: number }[] | [undefined],
  ] = await Promise.all([
    /* 实时余额（按仓汇总，剔 0） */
    db
      .select({
        warehouseId: schema.stockBalances.warehouseId,
        warehouseName: schema.warehouses.name,
        warehouseKind: schema.warehouses.kind,
        qty: sql<string>`sum(${schema.stockBalances.qty})`,
      })
      .from(schema.stockBalances)
      .innerJoin(schema.warehouses, eq(schema.stockBalances.warehouseId, schema.warehouses.id))
      .where(eq(schema.stockBalances.skuId, id))
      .groupBy(schema.stockBalances.warehouseId, schema.warehouses.name, schema.warehouses.kind)
      .having(sql`sum(${schema.stockBalances.qty}) <> 0`)
      .orderBy(schema.warehouses.name),
    /* 快照仓最新快照 */
    db
      .select({ warehouseId: s.warehouseId, warehouseName: schema.warehouses.name, bizDate: s.bizDate, qty: s.qty })
      .from(s)
      .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)))
      .innerJoin(schema.warehouses, eq(s.warehouseId, schema.warehouses.id))
      .where(eq(s.skuId, id)),
    /* 效期批次：最近到期前 10 */
    db
      .select({
        warehouseName: schema.warehouses.name,
        batchNo: schema.batchStocks.batchNo,
        prodDate: schema.batchStocks.prodDate,
        expiryDate: schema.batchStocks.expiryDate,
        qty: schema.batchStocks.qty,
      })
      .from(schema.batchStocks)
      .innerJoin(schema.warehouses, eq(schema.batchStocks.warehouseId, schema.warehouses.id))
      .where(and(eq(schema.batchStocks.skuId, id), isNotNull(schema.batchStocks.expiryDate), sql`${schema.batchStocks.qty} > 0`))
      .orderBy(asc(schema.batchStocks.expiryDate))
      .limit(10),
    /* 月销量（按月×渠道，窗口在 JS 侧截近 6 月） */
    db
      .select({ month: sm.yearMonth, channelName: schema.channels.name, qty: sql<string>`sum(${sm.qty})` })
      .from(sm)
      .innerJoin(schema.channels, eq(sm.channelId, schema.channels.id))
      .where(eq(sm.skuId, id))
      .groupBy(sm.yearMonth, schema.channels.name),
    /* 在途：未收完的 PO 行（基础单位 open = qty×factor − receivedQty） */
    db
      .select({
        poId: schema.poDocs.id,
        docNo: schema.poDocs.docNo,
        status: schema.poDocs.status,
        supplierName: schema.suppliers.name,
        expectedDate: schema.poDocs.expectedDate,
        openQty: sql<string>`${schema.poLines.qty} * ${schema.poLines.uomFactor} - ${schema.poLines.receivedQty}`,
      })
      .from(schema.poLines)
      .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
      .innerJoin(schema.suppliers, eq(schema.poDocs.supplierId, schema.suppliers.id))
      .where(
        and(
          eq(schema.poLines.skuId, id),
          inArray(schema.poDocs.status, ["approved", "in_progress"]),
          sql`${schema.poLines.qty} * ${schema.poLines.uomFactor} - ${schema.poLines.receivedQty} > 0`,
        ),
      )
      .orderBy(desc(schema.poDocs.id)),
    /* 在制：本品为产出的执行中工单 */
    db
      .select({
        woId: schema.woDocs.id,
        docNo: schema.woDocs.docNo,
        status: schema.woDocs.status,
        supplierName: schema.suppliers.name,
        qty: schema.woDocs.qty,
        dueDate: schema.woDocs.dueDate,
      })
      .from(schema.woDocs)
      .innerJoin(schema.suppliers, eq(schema.woDocs.supplierId, schema.suppliers.id))
      .where(and(eq(schema.woDocs.productSkuId, id), inArray(schema.woDocs.status, ["pending", "approved", "in_progress"])))
      .orderBy(desc(schema.woDocs.id)),
    /* 近期流水 10 条 */
    db
      .select({
        id: schema.stockLedger.id,
        occurredAt: schema.stockLedger.occurredAt,
        sourceDocType: schema.stockLedger.sourceDocType,
        sourceDocId: schema.stockLedger.sourceDocId,
        warehouseName: schema.warehouses.name,
        qtyDelta: schema.stockLedger.qtyDelta,
        action: schema.stockLedger.action,
      })
      .from(schema.stockLedger)
      .innerJoin(schema.warehouses, eq(schema.stockLedger.warehouseId, schema.warehouses.id))
      .where(eq(schema.stockLedger.skuId, id))
      .orderBy(desc(schema.stockLedger.occurredAt), desc(schema.stockLedger.id))
      .limit(10),
    /* 生效 BOM */
    db
      .select({
        id: schema.boms.id,
        versionNo: schema.boms.versionNo,
        lineCount: sql<number>`count(${schema.bomLines.id})::int`,
      })
      .from(schema.boms)
      .leftJoin(schema.bomLines, eq(schema.bomLines.bomId, schema.boms.id))
      .where(and(eq(schema.boms.productSkuId, id), eq(schema.boms.status, "active")))
      .groupBy(schema.boms.id, schema.boms.versionNo),
  ]);

  /* 销量窗口：以该 SKU 最新有数月份回推 6 月，缺月补 0 */
  const monthTotals = new Map<string, number>();
  const channelTotals = new Map<string, number>();
  let maxYm: string | null = null;
  for (const r of salesRows) {
    if (maxYm == null || r.month > maxYm) maxYm = r.month;
  }
  const months = maxYm ? lastMonths(maxYm, 6) : [];
  const windowSet = new Set(months);
  for (const r of salesRows) {
    if (!windowSet.has(r.month)) continue;
    monthTotals.set(r.month, (monthTotals.get(r.month) ?? 0) + num(r.qty));
    channelTotals.set(r.channelName, (channelTotals.get(r.channelName) ?? 0) + num(r.qty));
  }
  const byMonth = months.map((m) => ({ month: m, qty: Math.round((monthTotals.get(m) ?? 0) * 10000) / 10000 }));
  const topChannels = [...channelTotals.entries()]
    .map(([name, qty]) => ({ name, qty: Math.round(qty * 10000) / 10000 }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 3);

  /* 流水单号解析：按来源表分组批量补查（≤6 次） */
  const idsByTable = new Map<string, Set<number>>();
  for (const r of ledgerRows) {
    const t = LEDGER_SOURCE_TABLE[r.sourceDocType] ?? "stock_doc";
    if (!idsByTable.has(t)) idsByTable.set(t, new Set());
    idsByTable.get(t)!.add(r.sourceDocId);
  }
  const DOC_TABLES: Record<string, AnyDb> = {
    sh: schema.shDocs,
    fl: schema.flDocs,
    tl: schema.tlDocs,
    ct: schema.ctDocs,
    js: schema.jsDocs,
    stock_doc: schema.stockDocs,
  };
  const docNoMaps = new Map<string, Map<number, string>>();
  await Promise.all(
    [...idsByTable.entries()].map(async ([t, ids]) => {
      const table = DOC_TABLES[t];
      const rows: { id: number; docNo: string }[] = await db
        .select({ id: table.id, docNo: table.docNo })
        .from(table)
        .where(inArray(table.id, [...ids]));
      docNoMaps.set(t, new Map(rows.map((r) => [r.id, r.docNo])));
    }),
  );

  return {
    sku: {
      id: skuRow.id,
      code: skuRow.code,
      name: skuRow.name,
      spec: skuRow.spec,
      version: skuRow.version,
      baseUom: skuRow.baseUom,
      skuType: skuRow.skuType,
      lifecycle: skuRow.lifecycle,
      active: skuRow.active,
      attrs: skuRow.attrs ?? null,
      brandName: skuRow.brandName,
      spuCode: skuRow.spuCode,
      spuName: skuRow.spuName,
    },
    balances,
    snapshots: snapRows
      .map((r) => ({
        ...r,
        ageDays: Math.max(0, Math.floor((todayMs - new Date(`${r.bizDate}T00:00:00+08:00`).getTime()) / 86_400_000)),
      }))
      .sort((a, b) => a.warehouseName.localeCompare(b.warehouseName)),
    batches: batchRows.map((r) => ({
      warehouseName: r.warehouseName,
      batchNo: r.batchNo,
      prodDate: r.prodDate,
      expiryDate: r.expiryDate,
      daysLeft: Math.floor((new Date(`${r.expiryDate}T00:00:00+08:00`).getTime() - todayMs) / 86_400_000),
      qty: r.qty,
    })),
    sales: { months, byMonth, topChannels },
    openDocs: { poLines: poLineRows, woDocs: woRows },
    ledger: ledgerRows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt),
      sourceDocType: r.sourceDocType,
      docNo: docNoMaps.get(LEDGER_SOURCE_TABLE[r.sourceDocType] ?? "stock_doc")?.get(r.sourceDocId) ?? null,
      warehouseName: r.warehouseName,
      qtyDelta: r.qtyDelta,
      action: r.action,
    })),
    activeBom: bomRow[0] ? { id: bomRow[0].id, versionNo: bomRow[0].versionNo, lineCount: bomRow[0].lineCount } : null,
  };
}
