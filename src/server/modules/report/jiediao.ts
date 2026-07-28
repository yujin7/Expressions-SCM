/**
 * R16 借调对账（04 §8.A）：借调 = 完成态调拨单 + reason='借调'。
 * 月末自动生成部门间借调对账矩阵，替代 借入/借出 手工透视表。
 * 只读报表口径；月份按过账时间（审批完成 updatedAt，Asia/Shanghai）归属。
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface JiediaoReport {
  month: string;
  /** 借出仓 → 借入仓 汇总矩阵（数量跨 SKU 直加，参考口径） */
  matrix: { fromWarehouse: string; toWarehouse: string; docCount: number; totalQty: number }[];
  /** 明细行（对账依据，可导出） */
  lines: {
    docNo: string;
    postedAt: string;
    fromWarehouse: string;
    toWarehouse: string;
    skuCode: string;
    skuName: string;
    baseUom: string;
    qty: string;
    remark: string | null;
  }[];
  /** 按仓净借入（+）/净借出（−）——对账签字页 */
  netByWarehouse: { warehouse: string; borrowedIn: number; lentOut: number; net: number }[];
}

/** 'YYYY-MM' → [monthStartUTC, nextMonthStartUTC)（Asia/Shanghai 口径） */
function monthRange(month: string): [Date, Date] {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError(400, "月份格式须为 YYYY-MM");
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1, -8)); // 上海 00:00 = UTC-8h
  const end = new Date(Date.UTC(y, m, 1, -8));
  return [start, end];
}

export async function getJiediaoReport(month: string, dbArg?: AnyDb): Promise<JiediaoReport> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [start, end] = monthRange(month);
  const fromWh = schema.warehouses;
  // toWarehouse 需要第二次 join 同表——drizzle alias
  const { alias } = await import("drizzle-orm/pg-core");
  const toWh = alias(schema.warehouses, "to_wh");

  const rows: {
    docNo: string;
    postedAt: Date;
    fromName: string;
    toName: string;
    skuCode: string;
    skuName: string;
    baseUom: string;
    qty: string;
    remark: string | null;
  }[] = await db
    .select({
      docNo: schema.stockDocs.docNo,
      postedAt: schema.stockDocs.updatedAt,
      fromName: fromWh.name,
      toName: toWh.name,
      skuCode: schema.skus.code,
      skuName: schema.skus.name,
      baseUom: schema.skus.baseUom,
      qty: schema.stockDocLines.qty,
      remark: schema.stockDocs.remark,
    })
    .from(schema.stockDocs)
    .innerJoin(schema.stockDocLines, eq(schema.stockDocLines.stockDocId, schema.stockDocs.id))
    .innerJoin(fromWh, eq(schema.stockDocLines.warehouseId, fromWh.id))
    .innerJoin(toWh, eq(schema.stockDocLines.toWarehouseId, toWh.id))
    .innerJoin(schema.skus, eq(schema.stockDocLines.skuId, schema.skus.id))
    .where(
      and(
        eq(schema.stockDocs.subtype, "transfer"),
        eq(schema.stockDocs.reason, "借调"),
        eq(schema.stockDocs.status, "completed"),
        gte(schema.stockDocs.updatedAt, start),
        lt(schema.stockDocs.updatedAt, end),
      ),
    )
    .orderBy(schema.stockDocs.docNo, sql`${schema.skus.code}`);

  const shDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const lines = rows.map((r) => ({
    docNo: r.docNo,
    postedAt: shDate.format(r.postedAt), // RT4：上海口径显示（跨月凌晨单不再显示出报表月之外的日期）
    fromWarehouse: r.fromName,
    toWarehouse: r.toName,
    skuCode: r.skuCode,
    skuName: r.skuName,
    baseUom: r.baseUom,
    qty: r.qty,
    remark: r.remark,
  }));

  const matrixMap = new Map<string, { fromWarehouse: string; toWarehouse: string; docs: Set<string>; totalQty: number }>();
  const netMap = new Map<string, { borrowedIn: number; lentOut: number }>();
  for (const r of rows) {
    const key = `${r.fromName}→${r.toName}`;
    const m = matrixMap.get(key) ?? { fromWarehouse: r.fromName, toWarehouse: r.toName, docs: new Set<string>(), totalQty: 0 };
    m.docs.add(r.docNo);
    m.totalQty += Number(r.qty);
    matrixMap.set(key, m);
    const f = netMap.get(r.fromName) ?? { borrowedIn: 0, lentOut: 0 };
    f.lentOut += Number(r.qty);
    netMap.set(r.fromName, f);
    const t = netMap.get(r.toName) ?? { borrowedIn: 0, lentOut: 0 };
    t.borrowedIn += Number(r.qty);
    netMap.set(r.toName, t);
  }

  return {
    month,
    matrix: [...matrixMap.values()]
      .map((m) => ({ fromWarehouse: m.fromWarehouse, toWarehouse: m.toWarehouse, docCount: m.docs.size, totalQty: Math.round(m.totalQty * 10000) / 10000 }))
      .sort((a, b) => b.totalQty - a.totalQty),
    lines,
    netByWarehouse: [...netMap.entries()]
      .map(([warehouse, v]) => ({
        warehouse,
        borrowedIn: Math.round(v.borrowedIn * 10000) / 10000,
        lentOut: Math.round(v.lentOut * 10000) / 10000,
        net: Math.round((v.borrowedIn - v.lentOut) * 10000) / 10000,
      }))
      .sort((a, b) => b.net - a.net),
  };
}
