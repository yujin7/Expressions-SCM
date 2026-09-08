/** JSON契约与展示/导出标签；销量计算仍只在服务端复用core/velocity。 */
export interface InventorySalesEvidence {
  salesQty: string | null;
  salesMonths: number;
  salesState: "missing" | "partial" | "registered";
}
export interface InventorySalesWindow {
  months: string[];
  latestMonth: string | null;
  divisorDays: number;
}
export function inventorySalesStatus(row: InventorySalesEvidence): string {
  if (row.salesState === "missing") return "无月销记录";
  if (row.salesState === "partial") return `缺月（${row.salesMonths}/3月已登记）`;
  return "3/3月已登记";
}
export function inventorySalesPeriod(window?: InventorySalesWindow): string {
  return window?.months.length ? `${window.months[0]} ～ ${window.months[window.months.length - 1]}` : "无正式月销窗口";
}
/** 只格式化，六位有效数字避免微量正/负日均被固定小数位舍成0。 */
export function formatInventoryDaily(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN", { maximumSignificantDigits: 6 });
}
export const INVENTORY_SALES_EXPORT_COLUMNS = [
  { key: "salesQty", title: "窗口已登记销量" },
  { key: "salesMonths", title: "已登记月份数（应为3）" },
  { key: "salesStatus", title: "月销证据（不代表全渠道完整）" },
  { key: "salesPeriod", title: "正式月销窗口" },
  { key: "salesDivisorDays", title: "历史日均分母（天）" },
] as const;
export function inventorySalesExport(row: InventorySalesEvidence, window: InventorySalesWindow) {
  return { salesQty: row.salesQty, salesMonths: row.salesMonths, salesStatus: inventorySalesStatus(row),
    salesPeriod: inventorySalesPeriod(window), salesDivisorDays: window.divisorDays };
}
