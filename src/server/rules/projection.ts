/**
 * #1 库存未来曲线（纯函数，报表/建议层——对标 Kinaxis/o9 的 projected on-hand）。
 *
 * 逐日推演：projected[d] = projected[d-1] + Σ当日到货 − 日均消耗。
 * 到货 = 有确认到货日的在途（PO expected_date、存量单 expect_date）；无日期的在途不进曲线
 * （诚实：日期未知的量不能假装某天到——单独在 meta.undatedInbound 汇总提示）。
 * 断货日 = 首个 projected ≤ 0 的日期（当前即为 0/负则为 today）。
 *
 * ── W2-#3：本模块**不再产出「最晚下单日」** ──
 * 曾经这里也算 orderByDate（断货日 − normalLeadDays，且以「跌破 0」为触发），
 * 而补货行用的是 `rules/timephased.ts`（以**跌破安全库存**为触发、倒推**生产+物流**总供应周期）。
 * 同一个 SKU、同一个时刻，抽屉与行会给出两个不同的「最晚下单日」——而这两个界面正是拿来互相印证的。
 * 唯一权威定为 `rules/timephased.ts`：
 *   ① 再订货点是安全库存线而不是 0——等到 0 才动手，已经把安全库存整段时间白白让掉了；
 *   ② 能补上货的周期是**总供应周期**（生产 + 物流/调拨），货离开工厂那天并不能卖。
 * 曲线负责画，判定归判定：调用方（`replenish/projection.ts`）拿引擎的安全库存与总周期去问 timephased。
 * 结构上让本模块再也算不出下单日，两套口径就无处复活。
 *
 * 纯展示层 number 运算（与既有 cover 口径同准），不产出记账数字。
 */

export interface DatedArrival {
  /** YYYY-MM-DD 到货日 */
  date: string;
  qty: number;
}

export interface ProjectionInput {
  today: string;
  startOnHand: number;
  daily: number; // 日均消耗（≥0）
  arrivals: DatedArrival[]; // 有日期的在途
  horizonDays: number; // 推演天数（含今天）
}

export interface ProjectionPoint {
  date: string;
  onHand: number; // 期末投影在手（可为负——真实缺口，不夹到 0）
  arrival: number; // 当日到货
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  /** 首个 ≤0 日；永不断货 = null */
  stockoutDate: string | null;
  /** 断货前天数（stockoutDate − today）；null=不断货 */
  daysToStockout: number | null;
}

const DAY_MS = 86_400_000;

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function projectInventory(input: ProjectionInput): ProjectionResult {
  const horizon = Math.max(1, Math.min(365, Math.floor(input.horizonDays)));
  const daily = Math.max(0, input.daily);

  // 到货按到货日归并（早于今天的到货并入今天，视为已在途即将入仓）
  const arrivalByDay = new Map<string, number>();
  for (const a of input.arrivals) {
    if (!a.date || a.qty <= 0) continue;
    const offset = Math.max(0, diffDays(input.today, a.date));
    if (offset >= horizon) continue; // 视野外到货不进曲线
    const day = addDays(input.today, offset);
    arrivalByDay.set(day, (arrivalByDay.get(day) ?? 0) + a.qty);
  }

  const points: ProjectionPoint[] = [];
  let onHand = input.startOnHand;
  let stockoutDate: string | null = null;
  for (let i = 0; i < horizon; i++) {
    const date = addDays(input.today, i);
    const arrival = arrivalByDay.get(date) ?? 0;
    onHand = onHand + arrival - daily;
    points.push({ date, onHand: Math.round(onHand * 100) / 100, arrival });
    if (stockoutDate == null && onHand <= 0) stockoutDate = date;
  }

  const daysToStockout = stockoutDate ? diffDays(input.today, stockoutDate) : null;
  return { points, stockoutDate, daysToStockout };
}
