/**
 * #1 单 SKU 库存未来曲线服务（报表层，只读）。
 *
 * ── W2-#3：最晚下单日只有一套口径 ──
 * 起点在库、日均、安全库存、总供应周期、到货全部取自**补货引擎本身**
 * （`getReplenishSuggestions`，按 skuIds 收窄到这一个 SKU），判定再交给唯一权威
 * `rules/timephased.timePhasedNetReq`。因此在无沙盘变量时，抽屉给出的
 * shortageDate / orderByDate / orderWindowMissed 与补货行**逐字相同**——
 * 不是"尽量一致"，而是同一个函数、同一份输入。
 * 此前抽屉自己算：跌破 0 触发、只减 normalLeadDays（不含物流/调拨），
 * 于是同一个 SKU 在两个用来互相印证的界面上给出两个下单日。
 *
 * 曲线本身仍由 `rules/projection.projectInventory` 画（它已不再产出任何下单日）。
 * 沙盘（#4）只改输入（多一批到货 / 覆盖日均），判定函数不变，故口径依然只有一套。
 *
 * ── W2 修复：引擎覆盖范围必须显式，不得静默当 0 ──
 * 补货引擎只跑 **active 成品**。此前引擎没有该 SKU 的行时，起点在库 / 日均 / 安全库存**一律落到 0**，
 * 抽屉照样画出一条平直的线，并因为「0 ≥ 安全库存 0」给出绿色的「视野内不会跌破安全库存」——
 * 对一个停用品/半成品/包材，这句话是**编出来的安心**：系统根本没算过它。
 * 现在返回显式的 `engineCovered: false` + `engineCoverageReason`，数值全部为 `null`（不是 0），
 * 抽屉据此只说「本 SKU 不在补货引擎覆盖范围内」，不画结论。
 */
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { projectInventory, type DatedArrival, type ProjectionResult } from "@/server/rules/projection";
import { timePhasedNetReq } from "@/server/rules/timephased";
import { getOpenSupplyLines } from "@/server/core/supply";
import { num } from "@/server/core/svc";
import { getReplenishSuggestions } from "./service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 引擎未覆盖的原因（引擎只跑 active 成品） */
export type EngineCoverageReason = "inactive" | "not_finished" | "not_in_engine";
export const ENGINE_COVERAGE_LABELS: Record<EngineCoverageReason, string> = {
  inactive: "该 SKU 已停用，补货引擎不计算停用品",
  not_finished: "该 SKU 不是成品（引擎只跑成品），没有补货口径的在库/日均/安全库存",
  not_in_engine: "补货引擎当前没有该 SKU 的行（可能被引擎的入选条件排除）",
};

export interface SkuProjection extends ProjectionResult {
  skuId: number;
  code: string;
  name: string;
  /**
   * 补货引擎是否覆盖本 SKU。false 时下面所有引擎口径的数（在库/日均/安全库存/周期/短缺日）
   * **一律为 null**，抽屉不得画任何「安全」结论——没算过不等于安全。
   */
  engineCovered: boolean;
  /** 未覆盖原因（覆盖时为 null） */
  engineCoverageReason: EngineCoverageReason | null;
  engineCoverageNote: string | null;
  /** 曲线起点 = 引擎的**可用在库**（账面在库已扣临期净额，W2-#2）；引擎未覆盖 = null */
  startOnHand: number | null;
  /** 账面在库（core/stock-view 口径，未扣临期）——两个数并排，不许只留一个；引擎未覆盖 = null */
  bookOnHand: number | null;
  /** 被扣掉的临期净额；0 = 无临期风险；引擎未覆盖 = null */
  expiringUnsellable: number | null;
  /** 日均消耗（引擎口径）；引擎未覆盖 = null（不是 0） */
  daily: number | null;
  /** 总供应周期（生产 + 物流/调拨）——与补货行同一个数 */
  leadDays: number | null;
  /** 安全库存水位（引擎口径）：判定以跌破它为准，而不是跌破 0；引擎未覆盖 = null */
  safetyQty: number | null;
  /** 首次跌破安全库存日（唯一权威 rules/timephased）；不发生 = null */
  shortageDate: string | null;
  daysToShortage: number | null;
  /** 最晚下单日 = 短缺日 − 总供应周期（与补货行同源同值） */
  orderByDate: string | null;
  orderWindowMissed: boolean;
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
  const [sku] = await db
    .select({
      id: schema.skus.id, code: schema.skus.code, name: schema.skus.name,
      active: schema.skus.active, skuType: schema.skus.skuType,
    })
    .from(schema.skus)
    .where(where);
  if (!sku) throw new ApiError(404, "SKU 不存在");
  const skuId: number = sku.id;

  /* 引擎行 = 起点在库 / 日均 / 安全库存 / 总供应周期的唯一来源。
     取不到（非成品或已停用——引擎只跑 active 成品）时诚实降级：曲线仍能画，
     但安全库存与总供应周期未知，判定字段按 timephased 的「无周期」分支返回 null，不臆造。 */
  const engine = await getReplenishSuggestions({ allRows: true, skuIds: [skuId] }, db);
  const row = engine.rows.find((r) => r.skuId === skuId) ?? null;
  /* 引擎没有这一行 = **没算过**，不是「算出来是 0」。原因按最具体的先说。 */
  const engineCoverageReason: EngineCoverageReason | null = row
    ? null
    : sku.active === false
      ? "inactive"
      : sku.skuType !== "finished"
        ? "not_finished"
        : "not_in_engine";

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

  const bookOnHand = row ? num(row.decisionEvidence.onHand) : 0;
  const startOnHand = row ? num(row.decisionEvidence.availableOnHand) : 0;
  const expiringUnsellable = row ? num(row.decisionEvidence.expiringUnsellable) : 0;
  const daily = row ? num(row.decisionEvidence.daily) : 0;
  const leadDays = row?.leadDays ?? null;
  const safetyQty = row?.safetyQty ?? 0;
  const coverTargetDays = row?.effectiveTarget ?? 0;

  /* 引擎未覆盖：立刻返回显式的"未覆盖"状态。绝不画曲线、绝不给短缺日/下单日——
     一条 0 的平线加一句「视野内不会跌破安全库存」是编出来的安心。 */
  if (engineCoverageReason != null) {
    return {
      points: [],
      stockoutDate: null,
      daysToStockout: null,
      skuId,
      code: sku.code,
      name: sku.name,
      engineCovered: false,
      engineCoverageReason,
      engineCoverageNote: ENGINE_COVERAGE_LABELS[engineCoverageReason],
      startOnHand: null,
      bookOnHand: null,
      expiringUnsellable: null,
      daily: null,
      leadDays: null,
      safetyQty: null,
      shortageDate: null,
      daysToShortage: null,
      orderByDate: null,
      orderWindowMissed: false,
      undatedInbound: Math.round(undated * 100) / 100,
      today,
      scenarioApplied: false,
    };
  }

  // #4 沙盘覆盖
  let scenarioApplied = false;
  const effArrivals = arrivals.slice();
  if (scenario?.extraInboundQty && scenario.extraInboundQty > 0 && scenario.extraInboundDate) {
    effArrivals.push({ date: scenario.extraInboundDate, qty: scenario.extraInboundQty });
    scenarioApplied = true;
  }
  const effDaily = scenario?.dailyOverride != null && scenario.dailyOverride >= 0 ? scenario.dailyOverride : daily;
  if (scenario?.dailyOverride != null && scenario.dailyOverride !== daily) scenarioApplied = true;

  const proj = projectInventory({ today, startOnHand, daily: effDaily, arrivals: effArrivals, horizonDays });
  /* 判定：与补货行同一个纯函数、同一份输入（沙盘只改输入）。
     视野必须用**引擎的**视野而不是曲线的 horizonDays——曲线视野是看图的人选的（默认 120 天），
     两者不同则短缺日会因为「看得远近」而不同，下单日随之漂移。 */
  const tp = timePhasedNetReq({
    today,
    onHand: startOnHand,
    daily: effDaily,
    arrivals: effArrivals,
    safetyQty,
    coverTargetDays,
    leadDays,
    horizonDays: row?.decisionEvidence.horizonDays ?? horizonDays,
  });
  return {
    ...proj,
    skuId,
    code: sku.code,
    name: sku.name,
    engineCovered: true,
    engineCoverageReason: null,
    engineCoverageNote: null,
    startOnHand: Math.round(startOnHand * 100) / 100,
    bookOnHand: Math.round(bookOnHand * 100) / 100,
    expiringUnsellable: Math.round(expiringUnsellable * 100) / 100,
    daily: Math.round(effDaily * 100) / 100,
    leadDays,
    safetyQty,
    shortageDate: tp.shortageDate,
    daysToShortage: tp.daysToShortage,
    orderByDate: tp.orderByDate,
    orderWindowMissed: tp.orderWindowMissed,
    undatedInbound: Math.round(undated * 100) / 100,
    today,
    scenarioApplied,
  };
}
