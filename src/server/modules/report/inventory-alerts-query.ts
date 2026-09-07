import type { InventoryAlertRow, InventoryAlertsReadModel } from "@/server/modules/report/inventory-alerts";
import { ApiError } from "@/server/modules/master/common";

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
}

export function validateInventoryAlertsQuery(query: InventoryAlertsQuery): void {
  if (query.status && !["alert", "watch", "ok"].includes(query.status)) throw new ApiError(400, "库存覆盖状态无效");
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
  const filtered = filterInventoryAlertRows(model.rows, query);
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(5000, Math.max(1, Math.floor(query.pageSize ?? 50)));
  return {
    ...model,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    filtered: { total: filtered.length, page, pageSize },
  };
}
