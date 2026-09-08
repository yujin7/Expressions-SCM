import type { InventoryAlertRow, InventoryAlertsReadModel } from "@/server/modules/report/inventory-alerts";
import { ApiError } from "@/server/modules/master/common";
import { compareDecimalValues } from "@/lib/decimal-sort";
import { INVENTORY_ALERT_SORT_OPTIONS, type InventoryAlertSort } from "@/lib/inventory-alert-sort";

/**
 * 库存预警表的服务端筛选/分页（审计 #8：筛选曾在浏览器里跑，链接不可分享、整模型下发客户端）。
 * 纯函数、不碰读模型计算；totals 始终是读模型全量，filtered.total 才是当前筛选命中数。
 */
export interface InventoryAlertsQuery {
  q?: string;
  /** S/A/B/C；"none" = 未分层 */
  tier?: string;
  primary?: string;
  /** Same final coverage state used by summary totals; not the primary alert kind. */
  status?: string;
  /** "1"（缺省）= 只看有主预警或非 ok 的行；"0" = 全部 */
  onlyAlert?: string;
  /** "1" = 含 C 级；缺省折叠 C 级（D58） */
  showC?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: string;
}

export function validateInventoryAlertsQuery(query: InventoryAlertsQuery): void {
  if (query.status && !["alert", "watch", "ok"].includes(query.status)) throw new ApiError(400, "库存覆盖状态无效");
  if ((query.sort && !INVENTORY_ALERT_SORT_OPTIONS.some(option => option.value === query.sort))
    || (query.order && !["asc", "desc"].includes(query.order))
    || (query.order && !query.sort)) throw new ApiError(400, "库存预警排序无效，请选择排序字段与方向");
}

/** Preserve the authoritative risk order when no explicit user sort is selected. */
export function sortInventoryAlertRows(rows: InventoryAlertRow[], query: InventoryAlertsQuery): InventoryAlertRow[] {
  validateInventoryAlertsQuery(query);
  if (!query.sort) return rows;
  const sort = query.sort as Exclude<InventoryAlertSort, "">;
  const direction = query.order === "desc" ? -1 : 1;
  const grades = { S: 0, A: 1, B: 2, C: 3 };
  const value = (r: InventoryAlertRow) => sort === "tier" ? (r.tier == null ? null : grades[r.tier]) : r[sort];
  const codeOrder = (a: string, b: string) => a.localeCompare(b, "zh-CN", { numeric: true });
  return [...rows].sort((a, b) => {
    const left = value(a), right = value(b);
    // Unknown is neither zero nor a very large number. Direction never moves it to the top.
    if (left == null && right != null) return 1;
    if (left != null && right == null) return -1;
    const comparison = left == null || right == null ? 0 : sort === "code"
      ? codeOrder(String(left), String(right)) : compareDecimalValues(left, right);
    return comparison * direction || codeOrder(a.code, b.code) || a.skuId - b.skuId;
  });
}

export function filterInventoryAlertRows(rows: InventoryAlertRow[], query: InventoryAlertsQuery): InventoryAlertRow[] {
  validateInventoryAlertsQuery(query);
  const needle = (query.q ?? "").trim().toLowerCase();
  const onlyAlert = (query.onlyAlert ?? "1") !== "0";
  const showC = query.showC === "1";
  const tier = (query.tier ?? "").trim();
  const primary = (query.primary ?? "").trim();
  return rows.filter((r) =>
    (showC || r.tier !== "C")
    && (!onlyAlert || r.primary || r.status !== "ok")
    && (!tier || (tier === "none" ? r.tier == null : r.tier === tier))
    && (!primary || r.primary === primary)
    && (!query.status || r.status === query.status)
    && (!needle || r.code.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle) || (r.brand ?? "").toLowerCase().includes(needle)),
  );
}

export type InventoryAlertsPage = InventoryAlertsReadModel & { filtered: { total: number; page: number; pageSize: number } };

export function pageInventoryAlerts(model: InventoryAlertsReadModel, query: InventoryAlertsQuery): InventoryAlertsPage {
  const filtered = sortInventoryAlertRows(filterInventoryAlertRows(model.rows, query), query);
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(5000, Math.max(1, Math.floor(query.pageSize ?? 50)));
  return {
    ...model,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    filtered: { total: filtered.length, page, pageSize },
  };
}
