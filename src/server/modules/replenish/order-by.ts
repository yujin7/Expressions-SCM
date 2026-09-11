/**
 * 最晚下单日（W6）——补货引擎时间分段推演结果的**唯一对外读口**。
 *
 * 为什么要有这个模块：告警/待办此前用「今天 + 在库可销 − 交期」近似倒推截止日，
 * 而同一时刻补货页给出的是逐日推演（含有确认到货日的在途、安全库存水位）算出的 orderByDate。
 * 两个数字对同一个 SKU 说两种话，计划员按页面执行、待办却按另一个日子考核——
 * 与 workbench/focus 当初决定「复用 getReplenishSuggestions 而不是重算」的理由完全相同。
 *
 * 口径纪律：本模块**不重算任何东西**，只是把引擎输出按 SKU 索引出来；引擎没有答案（缺生产周期 /
 * 无动销 / 视野内不短缺）时返回 null，由调用方决定回退口径并**标注来源**，不许悄悄用近似值冒充引擎结果。
 */
import type { AnyDb } from "@/server/core/svc";
import { getReplenishSuggestions } from "./service";

export interface OrderByDateRow {
  skuId: number;
  code: string;
  /** 最晚下单日（短缺日 − 总供应周期）；引擎无答案 = null */
  orderByDate: string | null;
  shortageDate: string | null;
  daysToShortage: number | null;
  orderWindowMissed: boolean;
}

/**
 * 取一批 SKU 的最晚下单日。
 *
 * 实现上跑一次引擎（allRows，按 skuIds 收窄行集合）：引擎的口径由它自己的输入装配定义，
 * 在这里逐 SKU 另写一套既不会更快（同样要装配在库/在途/销速/参数），也会立刻产生第二套口径。
 * 调用方是看门狗这类**批量、低频**任务，一次跑完正是最省的形状。
 * @param skuIds 缺省 = 全部成品
 */
export async function getOrderByDates(db: AnyDb, skuIds?: number[]): Promise<OrderByDateRow[]> {
  const want = skuIds && skuIds.length > 0 ? new Set(skuIds) : null;
  const res = await getReplenishSuggestions({ allRows: true, skuIds: want ? [...want] : undefined }, db);
  const out: OrderByDateRow[] = [];
  for (const r of res.rows) {
    if (want && !want.has(r.skuId)) continue;
    out.push({
      skuId: r.skuId,
      code: r.code,
      orderByDate: r.orderByDate,
      shortageDate: r.shortageDate,
      daysToShortage: r.daysToShortage,
      orderWindowMissed: r.orderWindowMissed,
    });
  }
  return out;
}
