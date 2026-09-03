/**
 * 预警互斥（纯函数，唯一权威）：每 SKU 只出一个主预警，其余作标签；驾驶舱计数与表格计数同源。
 *
 * 固定优先级：out_of_stock > spike > low_stock(cover) > near_expiry > overstock。
 * priorityScore 统一数量量纲（不乘成本）= 日均销 × max(0, alertDays − 可销天数)，decimal 字符串（scale 4）；
 * 返回 {score, terms, formula}——分数可解释（W2：表格排序「为什么这行在上面」有答案）。
 * 输入只是"已算好的事实"（布尔命中），本模块不判定任何事实。
 */
import { type Dec, dMax, dMul, dSub } from "@/server/core/decimal";

export const ALERT_KINDS = ["out_of_stock", "spike", "low_stock", "near_expiry", "overstock"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  out_of_stock: "断货",
  spike: "爆单",
  low_stock: "库存预警",
  near_expiry: "临期",
  overstock: "积压",
};

export interface AlertFacts {
  outOfStock?: boolean;
  spike?: boolean;
  /** 在库可销天数 < 预警阈值（D57 alertDays） */
  lowStock?: boolean;
  nearExpiry?: boolean;
  overstock?: boolean;
}

export interface PrimaryAlert {
  primary: AlertKind | null;
  /** 其余命中，按优先级顺序 */
  tags: AlertKind[];
}

const FACT_KEY: Record<AlertKind, keyof AlertFacts> = {
  out_of_stock: "outOfStock",
  spike: "spike",
  low_stock: "lowStock",
  near_expiry: "nearExpiry",
  overstock: "overstock",
};

export function pickPrimaryAlert(facts: AlertFacts): PrimaryAlert {
  const hits = ALERT_KINDS.filter((k) => facts[FACT_KEY[k]] === true);
  return { primary: hits[0] ?? null, tags: hits.slice(1) };
}

export interface PriorityScoreInput {
  /** 日均销（数量） */
  dailyAvg: Dec | null;
  alertDays: number;
  /** 在库可销天数；null = 无销速 → 0 分 */
  coverDays: Dec | null;
}

/** 优先级分的可解释拆项（W2）：分数 = dailyAvg × gapDays，gapDays = max(0, alertDays − coverDays) */
export interface PriorityScoreTerms {
  /** 日均销（scale 4）；无销速 = null */
  dailyAvg: string | null;
  alertDays: number;
  /** 可销天数（scale 4）；无销速 = null */
  coverDays: string | null;
  /** 缺口天数 = max(0, alertDays − coverDays)（scale 4）；无销速 = "0.0000" */
  gapDays: string;
}

export interface PriorityScoreResult {
  /** 日均销 × 缺口天数，decimal 字符串 scale 4；无销速或无效值 → "0.0000" */
  score: string;
  terms: PriorityScoreTerms;
  /** 固定算式文案，供行上解释「为什么排在前面」 */
  formula: string;
}

export const PRIORITY_SCORE_FORMULA = "日均销 × max(0, 阈值天数 − 可销天数)";

const ZERO = "0.0000";

function finiteDec(v: Dec | null): boolean {
  if (v == null) return false;
  if (typeof v === "number") return Number.isFinite(v);
  return Number.isFinite(Number(v));
}

/** 日均销 × max(0, alertDays − coverDays)，scale 4；无销速或无效值 → score "0.0000"，terms 仍如实回填 */
export function priorityScore(input: PriorityScoreInput): PriorityScoreResult {
  const invalid = !finiteDec(input.dailyAvg) || !finiteDec(input.coverDays);
  if (invalid) {
    return {
      score: ZERO,
      terms: {
        dailyAvg: finiteDec(input.dailyAvg) ? dMax(0, input.dailyAvg as Dec, 4) : null,
        alertDays: input.alertDays,
        coverDays: finiteDec(input.coverDays) ? dMax(0, input.coverDays as Dec, 4) : null,
        gapDays: ZERO,
      },
      formula: PRIORITY_SCORE_FORMULA,
    };
  }
  const cover = input.coverDays as Dec;
  const gap = dMax(0, dSub(input.alertDays, cover, 4), 4);
  const daily = dMax(0, input.dailyAvg as Dec, 4);
  return {
    score: dMul(daily, gap, 4),
    terms: { dailyAvg: daily, alertDays: input.alertDays, coverDays: dMax(0, cover, 4), gapDays: gap },
    formula: PRIORITY_SCORE_FORMULA,
  };
}
