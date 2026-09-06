/**
 * W2-#6 建议放弃后的抑制窗口（纯函数）。
 *
 * 事故形状：`replenish/decline.ts` 只写一条审计，**下一次运行照旧建议同一个 SKU**。
 * 计划员每天对同一条建议重复做同一个判断——「已复核并放弃」变成一张只在当天有效的便签，
 * 采纳率里既看不出「已处理」，行为上也没有任何变化。
 *
 * 窗口长度按放弃原因取：原因不同，这个判断能管多久也不同。
 *  - supply_already_arranged（供应已安排）：判断依据是一件**系统还看不见的供应事实**。
 *    这件事只有三种结局，三种都必须提前解除（C8）：真到货（在库上升）、
 *    在系统里被登记成未结供给（全管道量上升）、或者**安排告吹**（全管道量下降 → 抑制的前提没了，
 *    继续抑制就是把一次真实缺货静音）。否则到期日偏移 30 天，含创建日最多 31 个自然日。
 *  - reference_stock_sufficient（全口径库存充足）：到期日偏移 21 天，含创建日 22 个自然日；外仓存量仍须核对。
 *  - delisting（计划下架）：长期决定，到期日偏移 90 天，含创建日 91 个自然日。
 *  - demand_overstated（需求估高）：**窗口最短**。需求判断比供应事实更容易错，
 *    压得越久越可能把真实的需求上升一起压掉——当前 days: 7 含创建日实际抑制 8 个自然日。
 *  - other：说不清理由的，当前同样含创建日抑制 8 个自然日。
 *    这两项的「7 天」应按 7 天还是 8 天执行，仍待 CURRENT.md D71 业务裁决；本次不改时长。
 *
 * 纪律：抑制**绝不静默**。被抑制的行照常出现在列表里，标着「已抑制」、原因、到期日，
 * 有权的计划员/管理员可人工解除。这里只定义"压多久、什么条件下提前解除"，落库与展示在 service 层。
 */
import type { DeclineReasonCode } from "@/lib/replenish-decline-reasons";
import { dayDiff } from "@/server/core/business-day";

export interface SuppressionPolicy {
  /** 到期日偏移天数（创建业务日期 + days）；含创建日和到期日，未提前解除时共 days + 1 个自然日。 */
  days: number;
  /** true = 供应事实一变（到货 / 被登记 / 被取消）即提前解除，不等窗口到期 */
  releaseOnArrival: boolean;
  /** 中文说明（行上 tooltip 直接用） */
  rationale: string;
}

export const SUPPRESSION_POLICY: Readonly<Record<DeclineReasonCode, SuppressionPolicy>> = {
  supply_already_arranged: {
    days: 30,
    releaseOnArrival: true,
    rationale: "供应已安排：这批供应到货入库、或在系统里被登记为未结供给、或安排被取消，三者任一发生即自动解除；含创建日最长 31 个自然日",
  },
  reference_stock_sufficient: {
    days: 21,
    releaseOnArrival: false,
    rationale: "全口径库存充足：含创建日抑制 22 个自然日；系统外仓存量仍须核对，可人工解除",
  },
  delisting: {
    days: 90,
    releaseOnArrival: false,
    rationale: "计划下架：属长期决定，含创建日抑制 91 个自然日，可人工解除",
  },
  demand_overstated: {
    days: 7,
    releaseOnArrival: false,
    rationale: "需求估高：当前含创建日抑制 8 个自然日，期满重新评估；时长待业务确认（D71）",
  },
  other: {
    days: 7,
    releaseOnArrival: false,
    rationale: "未归类原因：当前含创建日抑制 8 个自然日；时长待业务确认（D71）",
  },
};

const DAY_MS = 86_400_000;
const addDays = (ymd: string, d: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + d * DAY_MS).toISOString().slice(0, 10);

export interface SuppressionWindow {
  untilDate: string;
  releaseOnArrival: boolean;
  days: number;
  rationale: string;
}

export function suppressionWindowFor(reasonCode: DeclineReasonCode, businessDate: string): SuppressionWindow {
  const policy = SUPPRESSION_POLICY[reasonCode] ?? SUPPRESSION_POLICY.other;
  return {
    untilDate: addDays(businessDate, policy.days),
    releaseOnArrival: policy.releaseOnArrival,
    days: policy.days,
    rationale: policy.rationale,
  };
}

/**
 * 解除来源。`supply_arrived` / `supply_registered` / `supply_cancelled` 都只在
 * `releaseOnArrival` 的原因码上出现（目前只有 supply_already_arranged）。
 */
export type SuppressionRelease =
  | "expired"
  | "supply_arrived"
  | "supply_registered"
  | "supply_cancelled"
  | null;

export interface SuppressionStateInput {
  untilDate: string;
  releaseOnArrival: boolean;
  /** 放弃当时的全管道量（在库 + 未结供给） */
  pipelineBaseline: number;
  /** 当前全管道量 */
  pipelineNow: number;
  /**
   * 放弃当时的**账面在库**。到货是「在库 ↑、未结供给 ↓、全管道量不变」，
   * 只看全管道量的话这件事在数据上是**不可见**的（C8 事故：界面承诺「落库后自动解除」，
   * 实现上永远等到期）。
   */
  onHandBaseline: number;
  /** 当前账面在库 */
  onHandNow: number;
  today: string;
}

export interface SuppressionState {
  active: boolean;
  /** 已解除时说明是被什么解除的 */
  releasedBy: SuppressionRelease;
  /** 剩余天数（含今天）；已解除 = 0 */
  daysLeft: number;
}

/** 供应事实变化的判定阈值：比基线差出 1 个基础单位以上才算，避免小数噪声误解除。 */
const ARRIVAL_EPSILON = 1;

export function suppressionState(input: SuppressionStateInput): SuppressionState {
  if (input.today > input.untilDate) return { active: false, releasedBy: "expired", daysLeft: 0 };
  if (input.releaseOnArrival) {
    /* ① 真到货：账面在库上升。到货同时会把未结供给扣掉同样的量，**全管道量纹丝不动**，
          所以这一条必须看在库；只看管道量的旧实现让「落库后自动解除」这句承诺从未兑现过。 */
    if (input.onHandNow > input.onHandBaseline + ARRIVAL_EPSILON) {
      return { active: false, releasedBy: "supply_arrived", daysLeft: 0 };
    }
    /* ② 那件「系统还看不见的供应」被登记进来了（下了 PO / 建了 WO）：全管道量上升。
          放弃的前提（系统之外另有安排）已经变成系统内的事实，判断可以照常重做。 */
    if (input.pipelineNow > input.pipelineBaseline + ARRIVAL_EPSILON) {
      return { active: false, releasedBy: "supply_registered", daysLeft: 0 };
    }
    /* ③ 安排告吹：全管道量**掉到基线以下**（已安排的 PO 被作废/短关）。
          抑制建立在「有一批货在路上」这个前提上，前提没了还继续压到期限结束，
          等于把一次真实缺货静音——这是本条最重要的一半。 */
    if (input.pipelineNow < input.pipelineBaseline - ARRIVAL_EPSILON) {
      return { active: false, releasedBy: "supply_cancelled", daysLeft: 0 };
    }
  }
  /* 「含今天」不是措辞问题：解除条件是 `today > untilDate`，所以 today == untilDate 那天
     抑制**仍然生效**，而不含今天的算法在那天给出 0。于是窗口最后一天界面写着「剩 0 天」，
     采购建议却还被扣着——读者会以为窗口已过、系统坏了，实际是还差一天。
     +1 让读数与解除条件对齐：最后一天显示「剩 1 天」，过了才是 0。

     ⚠ 只改读数，**不动实际压制时长**：`untilDate = businessDate + days` 配上 `>` 解除，
     意味着 `days: 7` 的策略实际压 8 个自然日（建立当天 + 7 天）。「7 天」到底该压 7 天
     还是 8 天是业务口径，不由工程决定；在业务确认之前，压制行为保持现状不变，
     这里只保证界面说的和系统做的是同一件事。已登记 CURRENT.md D71 待业务确认。 */
  const daysLeft = Math.max(0, dayDiff(input.today, input.untilDate) + 1);
  return { active: true, releasedBy: null, daysLeft };
}
