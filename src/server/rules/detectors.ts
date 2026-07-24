/**
 * E5-10 轻量侦测器（纯函数层）：把「要等月底盘点才发现」的三类异动规则化。
 *
 * 纪律：本模块只做判定，不碰 DB、不取参数默认值以外的口径；
 * 取数与阈值组合在 modules/report/detectors.ts，展示在 /report/detectors。
 * 三条规则都是**提示**不是结论——命中只代表「值得看一眼」，需人工确认
 * （销量归零可能是链接下架，也可能是季节性/断货/换新链接）。
 *
 * 不判定原则（宁可不报，不可乱报）：
 * - 样本不足（销量序列 <3 期）→ 不判定；
 * - 分母为 0（历史均值 0 / 期总量 0 / 基线日均 ≤0）→ 不判定，绝不做 0 除。
 */

/** 保留 1 位小数（展示口径，判定一律用原始值） */
const r1 = (v: number): number => Math.round(v * 10) / 10;

/* ────────────────────────────── ① 销量骤停 ────────────────────────────── */

export interface SalesStopResult {
  /** 是否命中骤停 */
  stopped: boolean;
  /** 最近一期销量（序列末位） */
  lastQty: number;
  /** 之前若干期均值（末位除外） */
  prevAvg: number;
  /** 相对前期均值的跌幅（0.8 = 跌 80%）；无法计算 = null */
  dropPct: number | null;
  /** 判定说明（含不判定原因） */
  reason: string;
}

/**
 * 销量骤停：有历史销量，最近一期突然归零或暴跌。
 * @param series  升序月销量序列（末位 = 最近一期）
 * @param dropThreshold 跌幅阈值（默认 0.7 = 跌超 70% 即命中）
 */
export function detectSalesStop(series: number[], dropThreshold = 0.7): SalesStopResult {
  const n = series.length;
  const lastQty = n > 0 ? series[n - 1] : 0;
  // 样本不足：<3 期无法判断「常态」，不判定
  if (n < 3) {
    return { stopped: false, lastQty, prevAvg: 0, dropPct: null, reason: `样本不足（仅 ${n} 期，需 ≥3 期），不判定` };
  }
  const prev = series.slice(0, n - 1);
  const prevAvg = prev.reduce((a, b) => a + b, 0) / prev.length;
  // 历史均值为 0：无常态可比（新品/从未动销），不判定，也避免 0 除
  if (prevAvg <= 0) {
    return { stopped: false, lastQty, prevAvg: 0, dropPct: null, reason: "历史无销量（前期均值为 0），不判定" };
  }
  const dropPct = (prevAvg - lastQty) / prevAvg;
  if (lastQty === 0) {
    return {
      stopped: true,
      lastQty,
      prevAvg: r1(prevAvg),
      dropPct: r1(dropPct * 100) / 100,
      reason: `最近一期销量归零（前 ${prev.length} 期均值 ${r1(prevAvg)}）——疑似链接下架/失效或断货，非需求消失，需人工确认`,
    };
  }
  if (dropPct > dropThreshold) {
    return {
      stopped: true,
      lastQty,
      prevAvg: r1(prevAvg),
      dropPct: r1(dropPct * 100) / 100,
      reason: `最近一期 ${r1(lastQty)} 较前 ${prev.length} 期均值 ${r1(prevAvg)} 下跌 ${r1(dropPct * 100)}%（超阈值 ${r1(dropThreshold * 100)}%）——疑似链接下架/失效或断货，非需求消失，需人工确认`,
    };
  }
  return {
    stopped: false,
    lastQty,
    prevAvg: r1(prevAvg),
    dropPct: r1(dropPct * 100) / 100,
    reason: "最近一期销量在常态范围内",
  };
}

/* ──────────────────────────── ② 渠道结构迁移 ──────────────────────────── */

export interface ChannelMovement {
  /** 渠道标识（调用方传什么就是什么：code 或 name） */
  channel: string;
  /** 上期占比（%，1dp） */
  fromPct: number;
  /** 本期占比（%，1dp） */
  toPct: number;
  /** 占比变化（百分点，1dp；正=本期变重） */
  deltaPct: number;
}

export interface ChannelShiftResult {
  shifted: boolean;
  /** 按 |deltaPct| 降序 */
  movements: ChannelMovement[];
  note: string;
}

/**
 * 渠道结构迁移：某 SKU 各渠道占比较上期显著位移（量级变化不算，只看结构）。
 * @param prev 上期各渠道销量
 * @param curr 本期各渠道销量
 * @param minShiftPct 命中阈值（默认 15 个百分点）
 */
export function detectChannelShift(
  prev: Map<string, number>,
  curr: Map<string, number>,
  minShiftPct = 15,
): ChannelShiftResult {
  const sum = (m: Map<string, number>): number => {
    let t = 0;
    for (const v of m.values()) t += v;
    return t;
  };
  const prevTotal = sum(prev);
  const currTotal = sum(curr);
  // 任一期总量为 0 → 占比无定义（0 除），不判定
  if (prevTotal <= 0 || currTotal <= 0) {
    return { shifted: false, movements: [], note: "上期或本期总量为 0，占比无从计算，不判定" };
  }
  const keys = new Set<string>([...prev.keys(), ...curr.keys()]);
  const movements: ChannelMovement[] = [];
  let shifted = false;
  for (const k of keys) {
    const fromRaw = ((prev.get(k) ?? 0) / prevTotal) * 100;
    const toRaw = ((curr.get(k) ?? 0) / currTotal) * 100;
    const deltaRaw = toRaw - fromRaw;
    if (Math.abs(deltaRaw) > minShiftPct) shifted = true; // 判定用原始值，避免四舍五入擦边
    movements.push({ channel: k, fromPct: r1(fromRaw), toPct: r1(toRaw), deltaPct: r1(deltaRaw) });
  }
  movements.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct) || a.channel.localeCompare(b.channel));
  const top = movements[0];
  const note = shifted
    ? `渠道结构显著位移（阈值 ${minShiftPct} 个百分点）：${top.channel} ${top.fromPct}% → ${top.toPct}%（${top.deltaPct > 0 ? "+" : ""}${top.deltaPct}pp）`
    : `渠道结构无显著位移（最大变化 ${top ? Math.abs(top.deltaPct) : 0}pp，未超 ${minShiftPct} 个百分点）`;
  return { shifted, movements, note };
}

/* ────────────────────────────── ③ 速度突变 ────────────────────────────── */

export interface VelocityChangeResult {
  changed: boolean;
  direction: "up" | "down" | "flat";
  /** 相对基线的偏离（%，1dp；正=提速）；无法计算 = null */
  deviationPct: number | null;
}

/**
 * 速度突变：本期日均 vs 基线日均偏离超阈值。
 * @param threshold 偏离阈值（默认 0.4 = ±40%）
 */
export function detectVelocityChange(recentDaily: number, baselineDaily: number, threshold = 0.4): VelocityChangeResult {
  // 基线 ≤0 → 不判定（0 除保护；无基线谈不上「突变」）
  if (baselineDaily <= 0) return { changed: false, direction: "flat", deviationPct: null };
  const dev = (recentDaily - baselineDaily) / baselineDaily;
  const changed = Math.abs(dev) > threshold;
  return {
    changed,
    direction: changed ? (dev > 0 ? "up" : "down") : "flat",
    deviationPct: r1(dev * 100),
  };
}
