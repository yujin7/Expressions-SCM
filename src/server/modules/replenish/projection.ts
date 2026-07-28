/**
 * #1 单 SKU 库存未来曲线服务（报表层，只读）。
 * 起点在库=全网口径（实时账+快照，与 R11 同法）；到货走 core/supply 唯一权威（PO/存量单/WO 三源，行级交期优先）；
 * 日均=近3月÷91；生产周期=sku_params。推演走 rules/projection.ts 纯函数。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { projectInventory, type DatedArrival, type ProjectionResult } from "@/server/rules/projection";
import { dailyFromWindow, lastMonths } from "@/server/core/velocity";
import { getOnHandForSku } from "@/server/core/stock-view";
import { getOpenSupplyLines } from "@/server/core/supply";
import { num } from "@/server/core/svc";
import { salesWindow } from "@/server/core/sales-window";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

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

  /* 到货来源统一走 core/supply.getOpenSupplyLines（PO 在途 / 存量单在途 / WO 在制三源）。
     此前这里自行重装配了同样三段 SQL，与权威实现有两处实质差异：
       ① PO 到货日取的是**表头** po_docs.expected_date，而 core/supply 取**行级**
          po_lines.expected_date（无行级才回落表头）——供应商按行回交期后，
          同一张 PO 在补货页行内 shortageDate（走 core/supply）与本曲线会落在不同日期，
          而这两个页面正是用来互相印证的；
       ② WO 在制此处不判 isPaused 之外的状态细节，口径易与 core/supply 漂移。
     无确认到货日的量不进曲线，单独在 undatedInbound 提示（诚实降级，既有约定）。 */
  const arrivals: DatedArrival[] = [];
  let undated = 0;
  for (const l of await getOpenSupplyLines(db, [skuId])) {
    if (l.qty <= 0) continue;
    if (l.expectDate) arrivals.push({ date: l.expectDate, qty: l.qty });
    else undated += l.qty;
  }

  // 日均
  const sm = schema.salesMonthly;
  const { maxYm } = await salesWindow(db);
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
