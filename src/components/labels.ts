/** 枚举值 → 中文标签（客户端安全；constants.ts 为纯 TS，可直接复用） */

import { ORDER_TYPE_LABELS } from "@/server/core/constants";

export { ORDER_TYPE_LABELS };

/** 订单类型 → 中文（含 "MONTH_STOCK:<n>" 月备货存储形态） */
export function formatOrderType(v?: string | null): string {
  if (!v) return "—";
  if (ORDER_TYPE_LABELS[v]) return ORDER_TYPE_LABELS[v];
  const m = /^MONTH_STOCK:(\d+)$/.exec(v);
  if (m) return `${m[1]}月备货`;
  return v;
}

export const SKU_TYPE_LABELS: Record<string, string> = {
  finished: "成品",
  raw: "原料",
  packaging: "包材",
  semi: "半成品",
  service: "服务",
};

export const COMMERCIAL_ROLE_LABELS: Record<string, string> = {
  unclassified: "未分类",
  retail: "正常销售",
  sample: "样品",
  gift: "赠品",
  tester: "试用/测试装",
  internal: "内部使用",
};

export const SUPPLIER_KIND_LABELS: Record<string, string> = {
  raw: "原料",
  packaging: "包材",
  processor: "加工厂",
  service: "服务",
};

export const SUPPLIER_STATUS_LABELS: Record<string, string> = {
  pending: "准入中",
  qualified: "合格",
  blacklisted: "黑名单",
  paused: "暂停",
};

export const SUPPLIER_STATUS_COLORS: Record<string, string> = {
  pending: "processing",
  qualified: "success",
  blacklisted: "error",
  paused: "orange",
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

/** 库存单据子类型（stock_doc_subtype） */
export const STOCK_SUBTYPE_LABELS: Record<string, string> = {
  opening: "期初",
  issue_out: "领料出",
  sales_out: "销售出",
  transfer: "调拨",
  reversal: "红字冲销",
  purchase_in: "采购入",
  outsource_in: "委外入",
  outsource_in_spare: "委外入-备品",
  count_adjust: "盘点调整",
  loss_writeoff: "损耗核销",
  transit_writeoff: "调拨核销",
};

/** 统一单据状态机（doc_status） */
export const DOC_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  pending: "待审批",
  approved: "已审批",
  in_progress: "执行中",
  completed: "已完成",
  closed: "已关闭",
  void: "已作废",
};

/** 库存流水来源单据类型（sourceDocType） */
export const LEDGER_SOURCE_LABELS: Record<string, string> = {
  ...STOCK_SUBTYPE_LABELS,
  fl_issue: "发料",
  tl_return: "退料",
  sh_purchase_in: "采购收货",
  sh_outsource_in: "委外收货",
  ct_return: "采购退货",
  js_loss_writeoff: "结算核销",
  stock_doc: "红字冲销", // 该来源类型仅由红字 reverse() 产生（连贯性审计 m7 更名）
  sales_out: "销售出",
  spare_in: "备品入库",
};

export function toOptions(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
