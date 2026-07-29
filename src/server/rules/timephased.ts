/**
 * E2-05 时间分段净需求（time-phased netting，纯函数）。
 *
 * 原口径：毛需求 = 日均 × 目标覆盖天数，把未来压成一个数（单时间桶）。
 * 顶级系统按周/日分段 netting：逐期消耗、逐期到货，第一次跌破安全库存的那一期
 * 才是真正的需求点，需求量 = 补到目标水位所差的量。
 *
 * 本模块输出：
 * - 首次短缺期（shortageDate）与短缺量；
 * - 建议下单日 = 短缺日 − 总供应周期（生产 + 物流/调拨；早于今天则标记已错过窗口）；
 * - 建议量 = 把短缺期的水位补到「安全库存 + 目标覆盖天数需求」所需的量。
 *
 * 与 rules/projection.ts 的关系：projection 画曲线（可视化），本模块做净需求判定（决策）。
 * 两者共用同一到货/消耗输入，避免"图与建议不一致"。
 */

export interface TimePhasedInput {
  today: string;
  /** 期初可用 */
  onHand: number;
  /** 日均消耗 */
  daily: number;
  /** 有确认到货日的供给（无日期的不进推演——诚实：不假装某天到） */
  arrivals: { date: string; qty: number }[];
  /** 安全库存水位 */
  safetyQty: number;
  /** 目标覆盖天数（补到该水位） */
  coverTargetDays: number;
  /** 总供应周期（生产 + 物流/调拨，天）；null=无法倒推下单日 */
  leadDays: number | null;
  /** 推演天数 */
  horizonDays: number;
}

export interface TimePhasedResult {
  /** 首次跌破安全库存的日期；不发生 = null */
  shortageDate: string | null;
  /** 距今天数 */
  daysToShortage: number | null;
  /** 短缺当期的缺口（低于安全线的差额） */
  shortageQty: number;
  /** 建议补货量（补到 安全库存 + 目标覆盖需求）；无需补货 = 0 */
  requiredQty: number;
  /** 最晚下单日 = 短缺日 − 总供应周期 */
  orderByDate: string | null;
  /** 已错过下单窗口 */
  orderWindowMissed: boolean;
  /** 可解释：逐步说明 */
  explain: string[];
}

const DAY_MS = 86_400_000;
const addDays = (ymd: string, d: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + d * DAY_MS).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

export function timePhasedNetReq(input: TimePhasedInput): TimePhasedResult {
  const horizon = Math.max(1, Math.min(365, Math.floor(input.horizonDays)));
  const daily = Math.max(0, input.daily);
  const safety = Math.max(0, input.safetyQty);
  const explain: string[] = [];

  // 到货按日归并；早于今天的并入今天
  const arrivalByDay = new Map<string, number>();
  for (const a of input.arrivals) {
    if (!a.date || a.qty <= 0) continue;
    const off = Math.max(0, diffDays(input.today, a.date));
    if (off >= horizon) continue;
    const day = addDays(input.today, off);
    arrivalByDay.set(day, (arrivalByDay.get(day) ?? 0) + a.qty);
  }

  if (daily <= 0) {
    return {
      shortageDate: null, daysToShortage: null, shortageQty: 0, requiredQty: 0,
      orderByDate: null, orderWindowMissed: false,
      explain: ["无动销（日均=0），不产生时间分段需求"],
    };
  }

  let level = input.onHand;
  let shortageDate: string | null = null;
  let shortageQty = 0;
  for (let i = 0; i < horizon; i++) {
    const date = addDays(input.today, i);
    level += arrivalByDay.get(date) ?? 0;
    level -= daily;
    if (level < safety) {
      shortageDate = date;
      shortageQty = Math.ceil(safety - level);
      break;
    }
  }

  if (!shortageDate) {
    explain.push(`${horizon} 天视野内水位始终不低于安全库存 ${safety}，无需补货`);
    return {
      shortageDate: null, daysToShortage: null, shortageQty: 0, requiredQty: 0,
      orderByDate: null, orderWindowMissed: false, explain,
    };
  }

  // 补到「安全库存 + 目标覆盖天数需求」
  const targetLevel = safety + daily * Math.max(0, input.coverTargetDays);
  const requiredQty = Math.ceil(Math.max(0, targetLevel - (level)));
  const daysToShortage = diffDays(input.today, shortageDate);

  explain.push(`逐日推演：期初 ${Math.round(input.onHand)}，日耗 ${daily.toFixed(2)}，${arrivalByDay.size} 批有日期到货`);
  explain.push(`首次跌破安全库存 ${safety} 于 ${shortageDate}（${daysToShortage} 天后），当期缺口 ${shortageQty}`);
  explain.push(`补至目标水位 = 安全库存 ${safety} + 目标覆盖 ${input.coverTargetDays} 天需求 ${Math.round(daily * input.coverTargetDays)} → 需 ${requiredQty}`);

  let orderByDate: string | null = null;
  let orderWindowMissed = false;
  if (input.leadDays != null && input.leadDays > 0) {
    orderByDate = addDays(shortageDate, -Math.floor(input.leadDays));
    orderWindowMissed = diffDays(input.today, orderByDate) < 0;
    explain.push(
      orderWindowMissed
        ? `最晚下单日 ${orderByDate} 已过（总供应周期 ${input.leadDays} 天）——现在下单也赶不上，需紧急处置`
        : `最晚下单日 ${orderByDate}（短缺日倒推总供应周期 ${input.leadDays} 天）`,
    );
  } else {
    explain.push("无生产周期记录，无法形成总供应周期并倒推最晚下单日");
  }

  return { shortageDate, daysToShortage, shortageQty, requiredQty, orderByDate, orderWindowMissed, explain };
}
