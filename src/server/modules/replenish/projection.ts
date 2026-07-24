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
import { dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { getOnHandForSku } from "@/server/core/stock-view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
const num = (v: unknown): number => (v == null ? 0 : Number(v));


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

/** #4 沙盘覆盖：假设一批到货 / 覆盖日均，看曲线如何变化（不落库，纯推演） */
export interface ProjectionScenario {
  extraInboundQty?: number;
  extraInboundDate?: string; // YYYY-MM-DD
  dailyOverride?: number; // 覆盖日均消耗（如大促预估）
}

export async function getSkuProjection(
  skuCodeOrId: string | number,
  horizonDays = 120,
  dbArg?: AnyDb,
  scenario?: ProjectionScenario,
): Promise<SkuProjection & { scenarioApplied: boolean }> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const today = todayShanghai();

  const where =
    typeof skuCodeOrId === "number"
      ? eq(schema.skus.id, skuCodeOrId)
      : eq(schema.skus.code, String(skuCodeOrId).trim());
  const [sku] = await db.select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name }).from(schema.skus).where(where);
  if (!sku) throw new ApiError(404, "SKU 不存在");
  const skuId = sku.id;

  // 起点在库（core/stock-view 唯一口径）
  const { onHand: onHandStr } = await getOnHandForSku(db, skuId);
  const startOnHand = num(onHandStr);

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
  // func#2 在制委外产出：WO（已审批/执行中、未暂停）dueDate 作到货日；无日期计入 undated
  const woRows: { qty: string; dueDate: string | null }[] = await db
    .select({ qty: schema.woDocs.qty, dueDate: schema.woDocs.dueDate })
    .from(schema.woDocs)
    .where(and(eq(schema.woDocs.productSkuId, skuId), inArray(schema.woDocs.status, ["approved", "in_progress"]), eq(schema.woDocs.isPaused, false)));
  for (const r of woRows) {
    const q = num(r.qty);
    if (q <= 0) continue;
    if (r.dueDate) arrivals.push({ date: r.dueDate, qty: q });
    else undated += q;
  }

  // 日均
  const sm = schema.salesMonthly;
  const [{ maxYm }] = await db.select({ maxYm: sql<string | null>`max(${sm.yearMonth})` }).from(sm);
  const months3 = maxYm ? lastMonths(maxYm, 3) : [];
  const salesRows: { qty: string | null }[] = months3.length
    ? await db.select({ qty: sql<string | null>`sum(${sm.qty})` }).from(sm).where(and(eq(sm.skuId, skuId), inArray(sm.yearMonth, months3)))
    : [];
  const daily = dailyFromWindow(num(salesRows[0]?.qty));

  // 生产周期
  const [sp] = await db.select({ normalLeadDays: schema.skuParams.normalLeadDays }).from(schema.skuParams).where(eq(schema.skuParams.skuId, skuId));
  const leadDays = sp?.normalLeadDays ?? null;

  // #4 沙盘覆盖
  let scenarioApplied = false;
  const effArrivals = arrivals.slice();
  if (scenario?.extraInboundQty && scenario.extraInboundQty > 0 && scenario.extraInboundDate) {
    effArrivals.push({ date: scenario.extraInboundDate, qty: scenario.extraInboundQty });
    scenarioApplied = true;
  }
  const effDaily = scenario?.dailyOverride != null && scenario.dailyOverride >= 0 ? scenario.dailyOverride : daily;
  if (scenario?.dailyOverride != null && scenario.dailyOverride !== daily) scenarioApplied = true;

  const proj = projectInventory({ today, startOnHand, daily: effDaily, arrivals: effArrivals, horizonDays, leadDays });
  return {
    ...proj,
    skuId,
    code: sku.code,
    name: sku.name,
    startOnHand: Math.round(startOnHand * 100) / 100,
    daily: Math.round(effDaily * 100) / 100,
    leadDays,
    undatedInbound: Math.round(undated * 100) / 100,
    today,
    scenarioApplied,
  };
}
