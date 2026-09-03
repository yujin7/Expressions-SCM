/**
 * D63 采购订单周期（纯函数，唯一权威）。
 *
 * - 已下单时点 = PO 审批通过（orderedAt）；
 * - firstDays = 审批 → 首批 SH 收货（日历天，Asia/Shanghai 日界）；
 * - fullDays = 审批 → 全部收货完成；
 * - promiseDeviationDays = 首批收货日 − 承诺交期（正数=迟于承诺）；
 * 缺项一律 null，不猜。
 */

const SHANGHAI_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type DateLike = Date | string | null | undefined;

/** 任意时间 → Asia/Shanghai 业务日 YYYY-MM-DD；纯日期串（YYYY-MM-DD）原样视为业务日 */
export function shanghaiDay(v: DateLike): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    return SHANGHAI_FMT.format(new Date(t));
  }
  if (!(v instanceof Date) || !Number.isFinite(v.getTime())) return null;
  return SHANGHAI_FMT.format(v);
}

function dayDiff(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface PoCycleInput {
  orderedAt: DateLike;
  firstReceiptAt: DateLike;
  completedAt: DateLike;
  promisedDate: DateLike;
}

export interface PoCycleResult {
  firstDays: number | null;
  fullDays: number | null;
  /** 首批收货 − 承诺交期；正=迟到 */
  promiseDeviationDays: number | null;
}

export function orderToDeliveryDays(input: PoCycleInput): PoCycleResult {
  const ordered = shanghaiDay(input.orderedAt);
  const first = shanghaiDay(input.firstReceiptAt);
  const completed = shanghaiDay(input.completedAt);
  const promised = shanghaiDay(input.promisedDate);
  return {
    firstDays: dayDiff(ordered, first),
    fullDays: dayDiff(ordered, completed),
    promiseDeviationDays: dayDiff(promised, first),
  };
}
