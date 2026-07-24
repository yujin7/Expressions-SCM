/**
 * #1 单 SKU 库存未来曲线服务（报表层，只读）。
 * 起点在库=全网口径（实时账+快照，与 R11 同法）；到货=有日期的 PO 未收量 + 存量单未入库量；
 * 日均=近3月÷91；生产周期=sku_params。推演走 rules/projection.ts 纯函数。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { projectInventory, type DatedArrival, type ProjectionResult } from "@/server/rules/projection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
const num = (v: unknown): number => (v == null ? 0 : Number(v));

function lastMonths(maxYm: string, n: number): string[] {
  const [y, m] = maxYm.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out.reverse();
}

export interface SkuProjection extends ProjectionResult {
  skuId: number;
  code: string;
  name: string;
  startOnHand: number;
  daily: number;
  leadDays: number | null;
  /** 无到货日的在途量（不进曲线，单独提示） */
  undatedInbound: number;
  today: string;
}

export async function getSkuProjection(
  skuCodeOrId: string | number,
  horizonDays = 120,
  dbArg?: AnyDb,
): Promise<SkuProjection> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = todayShanghai();

  const where =
    typeof skuCodeOrId === "number"
      ? eq(schema.skus.id, skuCodeOrId)
      : eq(schema.skus.code, String(skuCodeOrId).trim());
  const [sku] = await db.select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name }).from(schema.skus).where(where);
  if (!sku) throw new ApiError(404, "SKU 不存在");
  const skuId = sku.id;

  // 起点在库
  const [{ bal }] = await db
    .select({ bal: sql<string | null>`sum(${schema.stockBalances.qty})` })
    .from(schema.stockBalances)
    .where(eq(schema.stockBalances.skuId, skuId));
  const s = schema.stockSnapshots;
  const latest = db
    .select({ warehouseId: s.warehouseId, skuId: s.skuId, maxDate: sql<string>`max(${s.bizDate})`.as("max_date") })
    .from(s)
    .where(eq(s.skuId, skuId))
    .groupBy(s.warehouseId, s.skuId)
    .as("latest");
  const snapRows: { qty: string }[] = await db
    .select({ qty: s.qty })
    .from(s)
    .innerJoin(latest, and(eq(latest.warehouseId, s.warehouseId), eq(latest.skuId, s.skuId), eq(latest.maxDate, s.bizDate)));
  let startOnHand = num(bal);
  for (const r of snapRows) startOnHand += num(r.qty);

  // 到货：PO 未收（有 expectedDate）
  const arrivals: DatedArrival[] = [];
  let undated = 0;
  const poRows: { qty: string; uomFactor: string; receivedQty: string; expectedDate: string | null }[] = await db
    .select({ qty: schema.poLines.qty, uomFactor: schema.poLines.uomFactor, receivedQty: schema.poLines.receivedQty, expectedDate: schema.poDocs.expectedDate })
    .from(schema.poLines)
    .innerJoin(schema.poDocs, eq(schema.poLines.poId, schema.poDocs.id))
    .where(and(eq(schema.poLines.skuId, skuId), inArray(schema.poDocs.status, ["approved", "in_progress"])));
  for (const r of poRows) {
    const remain = num(r.qty) * num(r.uomFactor) - num(r.receivedQty);
    if (remain <= 0) continue;
    if (r.expectedDate) arrivals.push({ date: r.expectedDate, qty: remain });
    else undated += remain;
  }
  // 存量单未入库（transit_refs fg_order，有 expectDate）
  const tr = schema.transitRefs;
  const fgRows: { qty: string | null; inboundQty: string | null; closedQty: string | null; expectDate: string | null }[] = await db
    .select({ qty: tr.qty, inboundQty: tr.inboundQty, closedQty: tr.closedQty, expectDate: tr.expectDate })
    .from(tr)
    .where(and(eq(tr.kind, "fg_order"), eq(tr.skuId, skuId)));
  for (const r of fgRows) {
    if (r.qty == null) continue;
    const remain = num(r.qty) - num(r.inboundQty) - num(r.closedQty);
    if (remain <= 0) continue;
    if (r.expectDate) arrivals.push({ date: r.expectDate, qty: remain });
    else undated += remain;
  }

  // 日均
  const sm = schema.salesMonthly;
  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const salesRows: { qty: string | null }[] = months3.length
    ? await db.select({ qty: sql<string | null>`sum(${sm.qty})` }).from(sm).where(and(eq(sm.skuId, skuId), inArray(sm.yearMonth, months3)))
    : [];
  const daily = num(salesRows[0]?.qty) / 91;

  // 生产周期
  const [sp] = await db.select({ normalLeadDays: schema.skuParams.normalLeadDays }).from(schema.skuParams).where(eq(schema.skuParams.skuId, skuId));
  const leadDays = sp?.normalLeadDays ?? null;

  const proj = projectInventory({ today, startOnHand, daily, arrivals, horizonDays: horizonDays, leadDays });
  return {
    ...proj,
    skuId,
    code: sku.code,
    name: sku.name,
    startOnHand: Math.round(startOnHand * 100) / 100,
    daily: Math.round(daily * 100) / 100,
    leadDays,
    undatedInbound: Math.round(undated * 100) / 100,
    today,
  };
}
