import type { InventoryAlertRow } from "./inventory-alerts";
import type { CsvColumn, ExportKindDef } from "./export";
import { filterInventoryAlertRows, sortInventoryAlertRows, validateInventoryAlertsQuery, type InventoryAlertsQuery } from "./inventory-alerts-query";
import { ApiError } from "@/server/modules/master/common";

const FILTER_KEYS = ["q", "tier", "primary", "status", "onlyAlert", "showC", "sort", "order"] as const;

/** Export shares the list's filters/order, but never its page or the 5000-row page cap. */
export function inventoryAlertExportQuery(params: Record<string, unknown>): InventoryAlertsQuery {
  const query: InventoryAlertsQuery = {};
  for (const key of FILTER_KEYS) {
    const value = params[key];
    if (value != null && typeof value !== "string") throw new ApiError(400, "库存预警导出筛选无效");
    if (typeof value === "string") query[key] = value;
  }
  validateInventoryAlertsQuery(query);
  return query;
}

const TITLES = ["等级", "等级来源", "SKU", "名称", "品牌", "日销外部", "日销内部", "实时仓销售净出库日均", "主日销", "主日销来源", "外部近30天净件", "在库", "可销天数", "阈值天", "阈值依据", "状态", "主预警", "标签", "优先级分", "实时仓窗口开始(含)", "实时仓窗口结束(不含)", "实时仓销售净出库(含销售红字)", "非销售作业出库(未扣正向冲销,不作需求)", "内部月销窗口开始(含)", "内部月销窗口结束(不含)", "内部月销窗口自然日", "内部已登记销量", "内部有记录月份数(不证明完整覆盖)", "外部近7天净件", "外部近15天净件", "外部窗口截止(含)", "外部时点T+1内", ...([7, 15, 30] as const).flatMap(days => [`外部${days}日开始(含)`, `外部${days}日完整序列数`, `外部${days}日应有序列数`, `外部${days}日窗口完整`])];
// Quantity/evidence only; arbitrary model fields (including financial metadata) are never spread into CSV.
export const INVENTORY_ALERT_COLUMNS: CsvColumn[] = TITLES.map((title, index) => ({ key: `c${index}`, title }));

export function inventoryAlertExportRow(r: InventoryAlertRow): Record<string, unknown> {
  const values = [r.tier, r.tierSource, r.code, r.name, r.brand, r.daily.external, r.daily.internal, r.daily.ledger, r.primaryDaily, r.primaryDailySource, r.net30External, r.onHand, r.coverDays, r.alertDays, r.alertBasis, r.status, r.primary, r.tags.join("|"), r.priorityScore, r.ledgerDemand.startDay, r.ledgerDemand.endDayExclusive, r.ledgerDemand.salesNetQty, r.ledgerDemand.operationsOutQty, r.internalDemand.startDay, r.internalDemand.endDayExclusive, r.internalDemand.days, r.internalDemand.salesQty, r.internalDemand.observedMonths, r.net7External, r.net15External, r.externalDemand.anchorDate, r.externalDemand.current ? "是" : "否", ...([7, 15, 30] as const).flatMap(days => {
    const w = r.externalDemand.windows?.[days];
    return [w?.startDay ?? null, w?.completeSequences ?? null, w?.requiredSequences ?? null, w == null ? "未知" : w.complete ? "是" : "否"];
  })];
  return Object.fromEntries(INVENTORY_ALERT_COLUMNS.map((column, index) => [column.key, values[index]]));
}

export const inventoryAlertsExport: ExportKindDef = {
  nameCn: "库存预警",
  paramsFromSearch: sp => ({ ...inventoryAlertExportQuery(Object.fromEntries(sp)) }),
  async produce(_user, params, cap, db) {
    const query = inventoryAlertExportQuery(params);
    const { loadInventoryAlerts } = await import("./inventory-alerts");
    const model = await loadInventoryAlerts(db);
    const filtered = sortInventoryAlertRows(filterInventoryAlertRows(model.rows, query), query);
    return { rows: filtered.slice(0, cap).map(inventoryAlertExportRow), columns: INVENTORY_ALERT_COLUMNS, total: filtered.length };
  },
};
