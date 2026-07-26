/**
 * 销量月窗锚点：**「最近一期是哪个月」这件事的唯一实现**。
 *
 * 全系统的销速、可销天数、ABC、异动侦测、驾驶舱都以「sales_monthly 的最新月」
 * 为锚点回推月窗——但取这个锚点的两行 SQL 此前在 12 个模块里各写了一遍。
 *
 * 为什么它是口径而不只是重复代码：锚点决定**哪几个月算数**。
 * 一旦有人在某处加了 where（比如「只看已放行的月」或「排除当月未完月」），
 * 那个模块的窗口就会和其余 11 个错开，而两边各自都算得好好的、都不报错——
 * 这正是本仓最贵的一类缺陷（同一 SKU 在 A 页是 A 类、B 页是 B 类）。
 *
 * 注意：这里**不能**放进 `core/velocity.ts`——那是纯函数模块（无 IO），
 * 本函数要查库，混进去会破坏它的可测性。velocity 负责「窗口怎么折算」，
 * 本模块负责「窗口从哪开始」，`lastMonths` 仍是唯一的回推实现。
 *
 * 同仓另有一种锚点：`funnel.ts` / `qc-summary.ts` 用 `todayShanghai().slice(0,7)`
 * （按自然当月）。那是**不同语义**（业务日历 vs 数据到哪了），不在本模块收口范围内。
 */
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { lastMonths } from "@/server/core/velocity";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface SalesWindow {
  /** sales_monthly 的最新月（YYYY-MM）；表为空 = null */
  maxYm: string | null;
  /** 由 maxYm 回推的月窗（升序，末位=最近一期）；无数据 = [] */
  months: string[];
}

/**
 * 取销量月窗。
 * @param n 回推期数（默认 6）
 */
export async function salesWindow(db: AnyDb, n = 6): Promise<SalesWindow> {
  const sm = schema.salesMonthly;
  const [row]: { maxYm: string | null }[] = await db
    .select({ maxYm: sql<string | null>`max(${sm.yearMonth})` })
    .from(sm);
  const maxYm = row?.maxYm ?? null;
  return { maxYm, months: maxYm ? lastMonths(maxYm, n) : [] };
}
