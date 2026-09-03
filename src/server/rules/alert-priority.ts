/**
 * 预警互斥（纯函数，唯一权威）：每 SKU 只出一个主预警，其余作标签；驾驶舱计数与表格计数同源。
 *
 * 固定优先级：out_of_stock > spike > low_stock(cover) > near_expiry > overstock。
 * priorityScore 统一数量量纲（不乘成本）= 日均销 × max(0, alertDays − 可销天数)，decimal 字符串（scale 4）。
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

/** 日均销 × max(0, alertDays − coverDays)，scale 4；无销速或无效值 → "0.0000" */
export function priorityScore(input: PriorityScoreInput): string {
  if (input.dailyAvg == null || input.coverDays == null) return "0.0000";
  if (typeof input.coverDays === "number" && !Number.isFinite(input.coverDays)) return "0.0000";
  if (typeof input.dailyAvg === "number" && !Number.isFinite(input.dailyAvg)) return "0.0000";
  const gap = dMax(0, dSub(input.alertDays, input.coverDays, 4), 4);
  const daily = dMax(0, input.dailyAvg, 4);
  return dMul(daily, gap, 4);
}
