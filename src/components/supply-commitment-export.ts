import type { PromiseReliability } from "@/server/modules/report/supply-commitment";
import { purchaseLineHref } from "@/lib/document-links";

export function buildPromiseReliabilityExport(data: PromiseReliability) {
  const headers = [
    "截止日",
    "观察窗口",
    "权威层",
    "承诺版本",
    "当前承诺可信度",
    "原始承诺可信度",
    "可计算覆盖率",
    "原始版本覆盖率",
    "例外口径",
    "状态",
    "采购单号",
    "采购单ID",
    "采购行ID",
    "采购行入口（系统内路径）",
    "供应商编码",
    "供应商",
    "SKU编码",
    "SKU名称",
    "本行判断承诺日",
    "原始承诺日",
    "当前承诺日",
    "版本证据状态",
    "改期次数",
    "订购量（基础单位）",
    "承诺日前净接收量",
    "截止日净接收量",
    "当前短缺量",
    "基础单位",
    "迟延天数",
    "足量日期",
    "例外总数（原始与当前分列）",
    "本文件例外数",
    "取数说明",
    "外部对照门禁",
  ];
  const statusLabel = {
    on_time_in_full: "按期足量",
    late_full: "迟到补齐",
    overdue_short: "逾期未齐",
  } as const;
  const externalGate = data.externalEdges
    .map((edge) => `${edge.source}:${edge.state}:${edge.purpose}`)
    .join("；");
  const common = [
    data.asOf,
    `${data.windowFrom} 至 ${data.asOf}`,
    data.authority,
    data.promiseVersionState,
    data.rate == null ? "未知" : `${data.rate}%`,
    data.originalRate == null ? "未知" : `${data.originalRate}%`,
    data.coverage.calculablePct == null ? "未知" : `${data.coverage.calculablePct}%`,
    data.coverage.historyPct == null ? "未知" : `${data.coverage.historyPct}%`,
  ];
  const rows = data.exceptions.map((row) => [
    ...common,
    row.basis === "original" ? "原始承诺" : "当前承诺",
    statusLabel[row.status],
    row.docNo,
    row.poId,
    row.lineId,
    purchaseLineHref(row.poId, row.lineId) ?? "无效来源身份",
    row.supplierCode,
    row.supplierName,
    row.skuCode,
    row.skuName,
    row.promisedDate,
    row.originalPromisedDate ?? "未知",
    row.currentPromisedDate ?? "未知",
    row.promiseHistoryState,
    row.revisionCount,
    row.orderedQty,
    row.receivedByPromise,
    row.receivedAsOf,
    row.shortQty,
    row.baseUom,
    row.daysLate,
    row.fulfilledDate ?? "未足量",
    data.exceptionTotal,
    data.exceptions.length,
    "按指定观察窗读取执行时最新事实；不是页面快照；两种口径不可合并相加为采购行数",
    externalGate,
  ]);
  if (rows.length === 0) {
    const empty: (string | number)[] = Array(headers.length).fill("");
    common.forEach((value, i) => { empty[i] = value; });
    empty[headers.indexOf("状态")] = data.state === "ready" ? "窗口内无例外" : "证据不足";
    empty[headers.indexOf("例外总数（原始与当前分列）")] = 0;
    empty[headers.indexOf("本文件例外数")] = 0;
    empty[headers.indexOf("取数说明")] = "说明行，非采购例外；按指定观察窗读取执行时最新事实";
    empty[headers.indexOf("外部对照门禁")] = externalGate;
    rows.push(empty);
  }
  return {
    filename: `供给承诺可信度-${data.asOf}.csv`,
    headers,
    rows,
  };
}
