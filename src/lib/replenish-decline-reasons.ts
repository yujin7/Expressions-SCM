/**
 * 补货建议「已复核并放弃」原因码（零依赖纯常量，客户端可安全导入）。
 *
 * 唯一定义处：`server/modules/replenish/decline.ts` 从这里取值并再导出（zod enum 与审计写入共用）。
 * 本文件禁止 import 任何模块（tests/architecture/client-server-boundary.test.ts 的边界原则）。
 */

export const DECLINE_REASON_CODES = ["reference_stock_sufficient", "demand_overstated", "supply_already_arranged", "delisting", "other"] as const;
export type DeclineReasonCode = (typeof DECLINE_REASON_CODES)[number];

export const DECLINE_REASON_LABELS: Record<DeclineReasonCode, { label: string; hint: string }> = {
  reference_stock_sufficient: { label: "全口径库存充足", hint: "系统外仓 / 参考口径已有足够库存，无需下单" },
  demand_overstated: { label: "需求估高", hint: "日均销或预测偏高（促销尾巴 / 一次性大单），实际不需要" },
  supply_already_arranged: { label: "供应已安排", hint: "已有在途 / 在制 / 借入等系统未捕获的供应" },
  delisting: { label: "计划下架", hint: "该 SKU 即将停售或淘汰，不再补货" },
  other: { label: "其他", hint: "请在原因中说明" },
};
