/**
 * 库存流水来源单据 → 单据页的唯一映射（零依赖纯常量，客户端/服务端共用）。
 *
 * 为什么要有它：流水页的「来源」此前只是 `类型 #id` 的死文本——看到一条 −120 的出库，
 * 想知道是哪张单，只能自己去对应单据页手工搜。id 在页面上根本不可搜（页面搜的是单号），
 * 所以这串文本对使用者等于零。这里把 sourceDocType 映射到单据表与列表页，
 * 服务端补出单号，前端渲染成 `<单号>` 链接（列表页的 `q` 参数即单号搜索）。
 */
export type LedgerSourceTable = "stock_docs" | "fl_docs" | "tl_docs" | "sh_docs" | "ct_docs" | "js_docs";

export interface LedgerSourceTarget {
  table: LedgerSourceTable;
  /** 单据列表页路径；单号进 `?q=`（列表页状态平台统一支持） */
  path: string;
}

export const LEDGER_SOURCE_TARGETS: Record<string, LedgerSourceTarget> = {
  opening: { table: "stock_docs", path: "/inventory/docs" },
  issue_out: { table: "stock_docs", path: "/inventory/docs" },
  sales_out: { table: "stock_docs", path: "/inventory/docs" },
  transfer: { table: "stock_docs", path: "/inventory/docs" },
  count_adjust: { table: "stock_docs", path: "/inventory/docs" },
  reversal: { table: "stock_docs", path: "/inventory/docs" },
  transit_writeoff: { table: "stock_docs", path: "/inventory/docs" },
  /** reverse() 的载体：sourceDocId = 红字单 id */
  stock_doc: { table: "stock_docs", path: "/inventory/docs" },
  fl_issue: { table: "fl_docs", path: "/matflow/fl" },
  tl_return: { table: "tl_docs", path: "/matflow/tl" },
  sh_purchase_in: { table: "sh_docs", path: "/matflow/sh" },
  sh_outsource_in: { table: "sh_docs", path: "/matflow/sh" },
  spare_in: { table: "sh_docs", path: "/matflow/sh" },
  ct_return: { table: "ct_docs", path: "/matflow/ct" },
  js_loss_writeoff: { table: "js_docs", path: "/settlement/js" },
};

/** 来源行 → 单据页链接；无映射或未解析到单号时返回 null（前端回落为纯文本，不造假链接） */
export function ledgerSourceHref(sourceDocType: string, docNo: string | null): string | null {
  const target = LEDGER_SOURCE_TARGETS[sourceDocType];
  if (!target || !docNo) return null;
  return `${target.path}?q=${encodeURIComponent(docNo)}`;
}
