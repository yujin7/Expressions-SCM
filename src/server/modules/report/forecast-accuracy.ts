/**
 * E7-05 预测复盘看板（服务层）。
 *
 * 用 rules/backtest 的滚动回测评估 rules/forecast 的 Holt 预测：
 * 逐 SKU 取月度销量序列，对每个可测期只用其之前的数据预测，与实际比较。
 * **复用真实预测算法**（forecastDaily）而非另写一套——否则复盘的不是线上口径。
 *
 * 口径：月序列取近 12 个自然月（lastMonths 唯一口径）；月缺失补 0（该月无销量记录=未动销）。
 * 只读，不写库，无金额字段。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { lastMonths, DAYS_PER_MONTH } from "@/server/core/velocity";
import { forecastDaily } from "@/server/rules/forecast";
import { backtest, biasLabel, fvaLabel, type BacktestResult } from "@/server/rules/backtest";
import { num } from "@/server/core/svc";
import { salesWindow } from "@/server/core/sales-window";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface ForecastAccuracyRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  /** 参与回测的期数 */
  n: number;
  mape: number | null;
  wape: number | null;
  bias: number | null;
  hitRate: number | null;
  /** 朴素预测（下月＝上月）同口径 WAPE */
  naiveWape: number | null;
  /** FVA = naiveWape − wape：>0 模型加分，≤0 不如照抄上月 */
  fva: number | null;
  reliable: boolean;
  biasText: string;
  fvaText: string;
  /** 近 12 月实际 vs 回测预测（供图表） */
  points: BacktestResult["points"];
}

export interface ForecastAccuracyResult {
  rows: ForecastAccuracyRow[];
  total: number;
  summary: {
    /** 可回测 SKU 数（历史足够） */
    evaluated: number;
    /** 加权 WAPE（按销量加权——比简单平均更有代表性） */
    overallWape: number | null;
    /** 整体偏差方向 */
    overallBias: number | null;
    overallBiasText: string;
    /** 系统性高估/低估的 SKU 数（|bias|>10%） */
    overCount: number;
    underCount: number;
    /** 全局朴素基准 WAPE 与 FVA——回答「这套预测整体上值不值」 */
    overallNaiveWape: number | null;
    overallFva: number | null;
    overallFvaText: string;
    /** 预测做负功（FVA<−2%）的 SKU 数——应改用朴素口径 */
    worseThanNaiveCount: number;
    months: string[];
  };
}

/** 把月销量序列喂给线上 Holt 算法，取"下一期月销"预测（forecastDaily 返回月/日两个口径） */
function holtNextMonth(history: number[]): number {
  const r = forecastDaily(history);
  // forecastMonthly 即下一期月销预测；若算法降级也照用（复盘的就是线上行为）
  return r.forecastMonthly > 0 ? r.forecastMonthly : r.forecastDaily * DAYS_PER_MONTH;
}

export async function getForecastAccuracy(
  query: { q?: string; page?: number; pageSize?: number; onlyReliable?: boolean },
  dbArg?: AnyDb,
): Promise<ForecastAccuracyResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();

  const sm = schema.salesMonthly;
  const { maxYm } = await salesWindow(db);
  const months = maxYm ? lastMonths(maxYm, 12) : [];
  if (months.length === 0) {
    return {
      rows: [], total: 0,
      summary: { evaluated: 0, overallWape: null, overallBias: null, overallBiasText: "无销量数据", overCount: 0, underCount: 0, overallNaiveWape: null, overallFva: null, overallFvaText: "样本不足，无法与朴素预测对比", worseThanNaiveCount: 0, months: [] },
    };
  }

  const skuRows: { id: number; code: string; name: string; brand: string | null }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, brand: schema.brands.nameCn })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(and(eq(schema.skus.skuType, "finished" as const), eq(schema.skus.active, true)));
  if (skuRows.length === 0) {
    return {
      rows: [], total: 0,
      summary: { evaluated: 0, overallWape: null, overallBias: null, overallBiasText: "无成品", overCount: 0, underCount: 0, overallNaiveWape: null, overallFva: null, overallFvaText: "样本不足，无法与朴素预测对比", worseThanNaiveCount: 0, months },
    };
  }
  const skuIds = skuRows.map((s) => s.id);

  const monthlyRows: { skuId: number; ym: string; qty: string | null }[] = await db
    .select({ skuId: sm.skuId, ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
    .from(sm)
    .where(and(inArray(sm.skuId, skuIds), inArray(sm.yearMonth, months)))
    .groupBy(sm.skuId, sm.yearMonth);
  const byS = new Map<number, Map<string, number>>();
  for (const r of monthlyRows) {
    let m = byS.get(r.skuId);
    if (!m) { m = new Map(); byS.set(r.skuId, m); }
    m.set(r.ym, num(r.qty));
  }

  let sumAbsErr = 0;
  let sumActual = 0;
  let sumErr = 0;
  let sumAbsNaiveErr = 0;
  let overCount = 0;
  let underCount = 0;
  let worseThanNaiveCount = 0;

  const all: ForecastAccuracyRow[] = [];
  for (const s of skuRows) {
    const m = byS.get(s.id);
    if (!m || m.size === 0) continue; // 从无销量记录的 SKU 不参与复盘
    const series = months.map((ym) => ({ ym, qty: m.get(ym) ?? 0 }));
    const bt = backtest(series, holtNextMonth, 3);
    if (bt.n === 0) continue;

    for (const p of bt.points) {
      sumActual += p.actual;
      sumAbsErr += Math.abs(p.error);
      sumErr += p.error;
      sumAbsNaiveErr += Math.abs(p.naive - p.actual);
    }
    if (bt.bias != null && bt.bias > 0.1) overCount++;
    if (bt.bias != null && bt.bias < -0.1) underCount++;
    if (bt.fva != null && bt.fva < -0.02) worseThanNaiveCount++;

    all.push({
      skuId: s.id, code: s.code, name: s.name, brand: s.brand,
      n: bt.n, mape: bt.mape, wape: bt.wape, bias: bt.bias, hitRate: bt.hitRate,
      naiveWape: bt.naiveWape, fva: bt.fva,
      reliable: bt.reliable, biasText: biasLabel(bt.bias),
      fvaText: fvaLabel(bt.fva, bt.naiveWape, bt.wape), points: bt.points,
    });
  }

  let filtered = all;
  if (query.onlyReliable) filtered = filtered.filter((r) => r.reliable);
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  // 误差大的排前（最值得看的先看）；无 wape 的殿后
  filtered.sort((a, b) => (b.wape ?? -1) - (a.wape ?? -1));

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const overallWape = sumActual > 0 ? r3(sumAbsErr / sumActual) : null;
  const overallBias = sumActual > 0 ? r3(sumErr / sumActual) : null;
  const overallNaiveWape = sumActual > 0 ? r3(sumAbsNaiveErr / sumActual) : null;
  const overallFva =
    overallWape != null && overallNaiveWape != null ? r3(overallNaiveWape - overallWape) : null;

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    summary: {
      evaluated: all.length,
      overallWape,
      overallBias,
      overallBiasText: biasLabel(overallBias),
      overCount,
      underCount,
      overallNaiveWape,
      overallFva,
      overallFvaText: fvaLabel(overallFva, overallNaiveWape, overallWape),
      worseThanNaiveCount,
      months,
    },
  };
}
