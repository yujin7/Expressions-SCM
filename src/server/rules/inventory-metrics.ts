/**
 * E7-04 库存分析：账龄（FIFO 回溯）与周转（周转次数/DIO）纯函数。
 *
 * 纪律（CLAUDE.md）：业务规则纯函数 + 单测，无 IO、无 DB、无时间副作用（today 由调用方传入）。
 * 口径说明：
 * - 账龄回答「已经压了多久」，与效期回答的「还能卖多久」互补——效期健康但压了半年的货同样是资金坟场。
 * - 本模块只做数量维度（本系统 stock_ledger 无金额），不做金额加权。
 */

/** 账龄桶键（≤30 / ≤60 / ≤90 / ≤180 / >180 天） */
export const AGING_BUCKETS = ["d30", "d60", "d90", "d180", "d180p"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** 账龄桶中文标签（UI/导出共用，避免各处重复硬编码） */
export const AGING_LABELS: Record<AgingBucket, string> = {
  d30: "≤30天",
  d60: "31–60天",
  d90: "61–90天",
  d180: "91–180天",
  d180p: ">180天",
};

export interface AgingResult {
  /** 五桶恒定顺序返回（含 0 桶），便于图表轴稳定 */
  buckets: { key: AgingBucket; qty: number }[];
  /** 加权平均库龄 = Σ(qty×age)/Σqty（仅统计有入库日期来源的部分）；无可归属数量 = null */
  weightedAvgAgeDays: number | null;
  /**
   * 「来源不明」数量：在库 > 历史入库合计的差额（期初直接建账/快照仓无流水/流水缺失）。
   * 计入最老桶 d180p（保守：不明来源按最坏假设算作老货），但不参与加权平均库龄
   * （其无入库日期，编造年龄会污染均值）——绝不静默丢弃。
   */
  unknownOriginQty: number;
}

/** 日界差（YYYY-MM-DD 直减，与 report/risk.ts 的 daysBetween 同准） */
function ageDays(inboundDate: string, today: string): number {
  const d = Math.round((Date.parse(today) - Date.parse(inboundDate)) / 86_400_000);
  return Number.isFinite(d) ? Math.max(0, d) : 0; // 未来日期/脏数据 → 0 天（不产生负库龄）
}

function bucketOf(age: number): AgingBucket {
  if (age <= 30) return "d30";
  if (age <= 60) return "d60";
  if (age <= 90) return "d90";
  if (age <= 180) return "d180";
  return "d180p";
}

/**
 * 账龄分桶：按 FIFO 假设把当前在库回溯到入库批次。
 *
 * 消耗方向 = **按入库时间倒序（最近的先算作仍在库）**。
 * 理由：FIFO 下先进先出，早期入库的已经卖掉了，故账面剩下的必然是**最后进来的**那些批次。
 * 逐笔累计入库量直到覆盖 onHand，最后一笔按剩余量部分计入。
 *
 * @param inbounds 入库明细（date=YYYY-MM-DD，qty>0；顺序无所谓，函数内部排序）
 * @param onHand   当前在库（<=0 → 五个空桶、avg=null）
 * @param today    口径日 YYYY-MM-DD
 */
export function fifoAging(
  inbounds: { date: string; qty: number }[],
  onHand: number,
  today: string,
): AgingResult {
  const empty = (): { key: AgingBucket; qty: number }[] => AGING_BUCKETS.map((k) => ({ key: k, qty: 0 }));
  if (!(onHand > 0)) return { buckets: empty(), weightedAvgAgeDays: null, unknownOriginQty: 0 };

  const acc: Record<AgingBucket, number> = { d30: 0, d60: 0, d90: 0, d180: 0, d180p: 0 };
  // 倒序：日期新 → 旧
  const sorted = inbounds
    .filter((i) => i.qty > 0 && !!i.date)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  let remaining = onHand;
  let weightSum = 0; // Σ(qty×age)
  let datedQty = 0; // Σqty（有日期来源的部分）
  for (const inb of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(inb.qty, remaining);
    const age = ageDays(inb.date, today);
    acc[bucketOf(age)] += take;
    weightSum += take * age;
    datedQty += take;
    remaining -= take;
  }

  // 在库超过历史入库合计 → 差额记为「来源不明」，进最老桶且显式返回
  const unknownOriginQty = remaining > 0 ? remaining : 0;
  if (unknownOriginQty > 0) acc.d180p += unknownOriginQty;

  return {
    buckets: AGING_BUCKETS.map((k) => ({ key: k, qty: acc[k] })),
    weightedAvgAgeDays: datedQty > 0 ? weightSum / datedQty : null,
    unknownOriginQty,
  };
}

/**
 * 周转次数（年化）与 DIO（Days Inventory Outstanding，库存周转天数）。
 *
 * turns = 窗口出库量 / 平均在库 × (365 / windowDays)
 * dio   = 365 / turns
 *
 * 0 除保护：avgOnHand<=0 或 windowDays<=0 → 双 null（不返回 Infinity 污染报表）；
 * turns<=0（窗口内零出库）→ dio=null（"永远卖不完"不用一个假数字表达）。
 */
export function turnover(
  outboundQty: number,
  avgOnHand: number,
  windowDays: number,
): { turns: number | null; dio: number | null } {
  if (!(avgOnHand > 0) || !(windowDays > 0)) return { turns: null, dio: null };
  const out = outboundQty > 0 ? outboundQty : 0;
  const turns = (out / avgOnHand) * (365 / windowDays);
  return { turns, dio: turns > 0 ? 365 / turns : null };
}
