import type { PromiseReliability } from "@/server/modules/report/supply-commitment";

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
    externalGate,
  ]);
  if (rows.length === 0) {
    rows.push([
      ...common,
      "",
      data.state === "ready" ? "窗口内无例外" : "证据不足",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      externalGate,
    ]);
  }
  return {
    filename: `供给承诺可信度-${data.asOf}.csv`,
    headers,
    rows,
  };
}
