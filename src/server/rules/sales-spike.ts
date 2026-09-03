/**
 * D56 爆单规则（纯函数，唯一权威）。
 *
 * 命中：最近 consecutiveDays（默认 3）天每日销量都 ≥ 基线 × (1 + risePct/100)（默认 50%）；
 * 基线 = 判定窗口**之前** baselineDays（默认 7）天的日均（窗口内缺天按 0 计并记 gaps）；
 * 基线 < minBaseQty（默认 10）不命中（防小基数放大）。
 * 锚点 anchorDate = asOf 或序列最大日期；序列以日期升序 {date:'YYYY-MM-DD', qty} 给入（本函数会防御性排序）。
 * 数量走 decimal 字符串（禁 float）；risePct 逐日 = (qty − 基线)/基线 × 100（基线 0 → null）。
 * 本模块只判定，不落库、不推送、不改任何补货参数（观察数据只能预警，D55）。
 */
import { type Dec, dAdd, dCmp, dDeviationPct, dDiv, dMul, dQty } from "@/server/core/decimal";

export interface DailyPoint {
  /** YYYY-MM-DD（或可截取前 10 位的 ISO 串） */
  date: string;
  qty: Dec;
}

export interface SpikeOptions {
  consecutiveDays?: number;
  risePct?: number;
  minBaseQty?: number;
  baselineDays?: number;
  /** 锚点日（含）；缺省取序列最大日期 */
  asOf?: string;
}

export interface SpikeDay {
  date: string;
  qty: string;
  /** 相对基线涨幅 %（scale 2）；基线 0 → null */
  risePct: string | null;
  hit: boolean;
}

export interface SpikeResult {
  hit: boolean;
  anchorDate: string | null;
  /** 基线日均（scale 4） */
  baseline: string;
  /** 命中门槛 = 基线 × (1+risePct/100)（scale 4） */
  threshold: string;
  days: SpikeDay[];
  /** 判定窗口 + 基线窗口内缺失的天数（按 0 计） */
  gaps: number;
  reason: string;
}

function dayStr(d: string): string {
  return d.slice(0, 10);
}

function shiftDay(ymd: string, delta: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}

export function detectSalesSpike(dailySeries: DailyPoint[], opts: SpikeOptions = {}): SpikeResult {
  const consecutiveDays = Math.max(1, Math.trunc(opts.consecutiveDays ?? 3));
  const risePct = opts.risePct ?? 50;
  const minBaseQty = opts.minBaseQty ?? 10;
  const baselineDays = Math.max(1, Math.trunc(opts.baselineDays ?? 7));

  const byDate = new Map<string, string>();
  for (const p of dailySeries ?? []) {
    if (!p || !p.date) continue;
    const d = dayStr(p.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    byDate.set(d, dAdd(byDate.get(d) ?? "0", p.qty, 4));
  }
  const dates = [...byDate.keys()].sort();
  const anchorDate = opts.asOf ? dayStr(opts.asOf) : dates.length ? dates[dates.length - 1] : null;
  if (!anchorDate) {
    return { hit: false, anchorDate: null, baseline: "0.0000", threshold: "0.0000", days: [], gaps: 0, reason: "无日销序列" };
  }

  let gaps = 0;
  const read = (d: string): string => {
    const v = byDate.get(d);
    if (v == null) {
      gaps += 1;
      return "0.0000";
    }
    return v;
  };

  // 基线窗口：[anchor − consecutiveDays − baselineDays + 1, anchor − consecutiveDays]
  let baseSum = "0.0000";
  for (let i = consecutiveDays + baselineDays - 1; i >= consecutiveDays; i--) {
    baseSum = dAdd(baseSum, read(shiftDay(anchorDate, -i)), 4);
  }
  const baseline = dDiv(baseSum, baselineDays, 4);
  const factor = dDiv(dAdd(100, risePct, 6), 100, 6);
  const threshold = dMul(baseline, factor, 4);

  const days: SpikeDay[] = [];
  for (let i = consecutiveDays - 1; i >= 0; i--) {
    const d = shiftDay(anchorDate, -i);
    const qty = read(d);
    const hitDay = dCmp(baseline, 0) > 0 && dCmp(qty, threshold) >= 0;
    days.push({
      date: d,
      qty: dQty(qty),
      risePct: dCmp(baseline, 0) > 0 ? dDeviationPct(baseline, qty) : null,
      hit: hitDay,
    });
  }

  if (dCmp(baseline, minBaseQty) < 0) {
    return {
      hit: false, anchorDate, baseline, threshold, days, gaps,
      reason: `基线日均 ${baseline} 低于最小基数 ${minBaseQty}，不判爆单`,
    };
  }
  const hit = days.every((d) => d.hit);
  return {
    hit, anchorDate, baseline, threshold, days, gaps,
    reason: hit
      ? `连续 ${consecutiveDays} 天日销 ≥ 基线 ${baseline} × (1+${risePct}%)=${threshold}`
      : `最近 ${consecutiveDays} 天中 ${days.filter((d) => !d.hit).length} 天未达门槛 ${threshold}`,
  };
}

/** 运营计划事件（ops_plan_events kind=promo）最小投影 */
export interface PromoEvent {
  id: number;
  startDate: string;
  /** null = 未定结束 */
  endDate: string | null;
  expectedUpliftPct: number | null;
}

export interface ExpectedPromoMatch {
  /** true = 判定窗口与至少一个大促事件重叠——爆单在预期内 */
  expected: boolean;
  planEventRef: number | null;
  expectedUpliftPct: number | null;
  /** 重叠事件的窗口文案，如「大促 2026-09-01–2026-09-03」 */
  planEventWindow: string | null;
}

/**
 * 审计 #7：判定窗口 [windowStart, windowEnd]（含）与大促事件区间有交集 → expected:true。
 * 多个重叠事件取 expectedUpliftPct 最大者（null 视为最小），再按 id 小者稳定。
 * 只打标不丢弃——大促跑到自己预期 3 倍仍是新闻，由看门狗降级严重度。
 */
export function matchExpectedPromo(window: { start: string; end: string }, events: PromoEvent[]): ExpectedPromoMatch {
  const none: ExpectedPromoMatch = { expected: false, planEventRef: null, expectedUpliftPct: null, planEventWindow: null };
  const ws = dayStr(window.start), we = dayStr(window.end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ws) || !/^\d{4}-\d{2}-\d{2}$/.test(we) || ws > we) return none;
  const overlapping = (events ?? []).filter((e) => {
    const s = dayStr(e.startDate);
    const en = e.endDate ? dayStr(e.endDate) : null;
    return s <= we && (en == null || en >= ws);
  });
  if (!overlapping.length) return none;
  overlapping.sort((a, b) => (b.expectedUpliftPct ?? -Infinity) - (a.expectedUpliftPct ?? -Infinity) || a.id - b.id);
  const pick = overlapping[0];
  return {
    expected: true,
    planEventRef: pick.id,
    expectedUpliftPct: pick.expectedUpliftPct ?? null,
    planEventWindow: `大促 ${dayStr(pick.startDate)}${pick.endDate ? `–${dayStr(pick.endDate)}` : " 起"}`,
  };
}
