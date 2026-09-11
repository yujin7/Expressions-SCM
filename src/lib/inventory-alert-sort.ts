/** Shared display/query allowlist; no business quantities are calculated here. */
export const INVENTORY_ALERT_SORT_OPTIONS = [
  { value: "", label: "风险优先（默认）" },
  { value: "code", label: "SKU编码" },
  { value: "tier", label: "等级 S/A/B/C" },
  { value: "onHand", label: "在库数量" },
  { value: "coverDays", label: "可销天数" },
  { value: "net30External", label: "外部30日净件" },
  { value: "priorityScore", label: "优先级分" },
] as const;

export type InventoryAlertSort = (typeof INVENTORY_ALERT_SORT_OPTIONS)[number]["value"];
