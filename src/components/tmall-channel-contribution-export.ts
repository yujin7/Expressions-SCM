import type {
  TmallChannelContributionObservation,
  TmallContributionMonthSummary,
  TmallContributionShopMonth,
  TmallContributionSourceEvidence,
} from "@/server/modules/report/tmall-channel-contribution";

export interface TmallContributionCsvExport {
  filename: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

function exportTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

const HEADERS = [
  "记录类型", "权限口径", "来源系统", "平台", "共同业务起始", "共同业务截止", "最近完整月",
  "导出时间", "来源流", "批次源更新时间", "来源业务起始", "来源业务截止",
  "源行数", "staging行数", "有效行数", "无效行数",
  "月份", "店铺", "币种", "可比", "销售行", "退款行", "费用行",
  "支付金额", "成功退款金额", "净回款观察", "平台费用支付金额", "产品成本前渠道贡献",
  "退款金额率%", "平台费/净回款%", "可比店铺", "全部店铺", "被排除费用金额",
  "缺失来源", "判断门禁", "源系统核对值", "差异金额", "差异原因", "责任人",
  "处理期限", "证据编号", "签认状态",
];

function sourceRow(
  signal: TmallChannelContributionObservation,
  generatedAt: string,
  source: TmallContributionSourceEvidence,
): TmallContributionCsvExport["rows"][number] {
  return [
    "source_control", signal.authority, signal.source, signal.platform,
    signal.commonBusinessDateFrom, signal.commonBusinessDateThrough, signal.latestClosedMonth,
    generatedAt, source.stream, source.sourceAsOf, source.businessDateFrom,
    source.businessDateThrough, source.sourceRows, source.stagedRows, source.validRows,
    source.invalidRows,
    null, null, null, source.invalidRows === 0 ? "是" : "否", null, null, null,
    null, null, null, null, null, null, null, null, null, null,
    source.invalidRows > 0 ? "存在无效来源行" : "", signal.gate,
    null, null, null, null, null, null, "待签认",
  ];
}

function monthRow(
  signal: TmallChannelContributionObservation,
  generatedAt: string,
  row: TmallContributionMonthSummary,
): TmallContributionCsvExport["rows"][number] {
  return [
    "month_control", signal.authority, signal.source, signal.platform,
    signal.commonBusinessDateFrom, signal.commonBusinessDateThrough, signal.latestClosedMonth,
    generatedAt, null, null, null, null, null, null, null, null,
    row.month, "全部可比店铺", row.currency, "是", null, null, null,
    row.grossPaidAmount, row.successfulRefundAmount, row.netCollectedObservation,
    row.platformFeePaidAmount, row.contributionBeforeProductCost, row.refundAmountRatePct,
    row.platformFeeRatePct, row.comparableShops, row.totalShops, row.excludedFeePaidAmount,
    row.comparableShops === row.totalShops ? "" : "存在未形成三源可比的店铺", signal.gate,
    null, null, null, null, null, null, "待签认",
  ];
}

function shopRow(
  signal: TmallChannelContributionObservation,
  generatedAt: string,
  row: TmallContributionShopMonth,
): TmallContributionCsvExport["rows"][number] {
  return [
    "latest_closed_month_shop", signal.authority, signal.source, signal.platform,
    signal.commonBusinessDateFrom, signal.commonBusinessDateThrough, signal.latestClosedMonth,
    generatedAt, null, null, null, null, null, null, null, null,
    row.month, row.shopName, row.currency, row.comparable ? "是" : "否",
    row.salesRows, row.refundRows, row.feeRows, row.grossPaidAmount,
    row.successfulRefundAmount, row.netCollectedObservation, row.platformFeePaidAmount,
    row.contributionBeforeProductCost, row.refundAmountRatePct, row.platformFeeRatePct,
    null, null, null, row.missingSources.join("/"), signal.gate,
    null, null, null, null, null, null, "待签认",
  ];
}

/** 财务 UAT 核对包：来源批次 + 月份控制 + 最近完整月逐店铺，并预留人工签认栏。 */
export function buildTmallChannelContributionExport(
  signal: TmallChannelContributionObservation,
  now = new Date(),
): TmallContributionCsvExport {
  const generatedAt = now.toISOString();
  return {
    filename: `简道云-天猫渠道金额贡献桥-${signal.latestClosedMonth ?? "无完整月"}-${exportTimestamp(now)}.csv`,
    headers: HEADERS,
    rows: [
      ...Object.values(signal.sources)
        .filter((source): source is TmallContributionSourceEvidence => source != null)
        .map((source) => sourceRow(signal, generatedAt, source)),
      ...signal.monthly.map((row) => monthRow(signal, generatedAt, row)),
      ...signal.latestShops.map((row) => shopRow(signal, generatedAt, row)),
    ],
  };
}
