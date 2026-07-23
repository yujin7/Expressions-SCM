/** 枚举值 → 中文标签（客户端安全，无服务端依赖） */

export const SKU_TYPE_LABELS: Record<string, string> = {
  finished: "成品",
  raw: "原料",
  packaging: "包材",
};

export const SUPPLIER_KIND_LABELS: Record<string, string> = {
  raw: "原料",
  packaging: "包材",
  processor: "加工厂",
};

export const SUPPLIER_STATUS_LABELS: Record<string, string> = {
  pending: "准入中",
  qualified: "合格",
  blacklisted: "黑名单",
};

export const SUPPLIER_STATUS_COLORS: Record<string, string> = {
  pending: "processing",
  qualified: "success",
  blacklisted: "error",
};

export const WAREHOUSE_KIND_LABELS: Record<string, string> = {
  finished: "成品仓",
  raw: "原料仓",
  packaging: "包材仓",
  outsource: "委外仓",
  transit: "调拨在途",
  snapshot: "快照仓",
};

export const BOM_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  active: "生效",
  retired: "停用",
};

export const BOM_STATUS_COLORS: Record<string, string> = {
  draft: "default",
  active: "success",
  retired: "warning",
};

export const LOSS_CATEGORY_LABELS: Record<string, string> = {
  raw: "原料",
  packaging: "包材",
};

export function toOptions(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
