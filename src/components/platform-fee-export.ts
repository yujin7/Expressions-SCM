import type {
  JiandaoyunPlatformFeeObservation,
  PlatformFeeDimensionRow,
} from "@/server/modules/report/platform-fee-observation";

export interface PlatformFeeCsvExport {
  filename: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

function exportTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

const HEADERS = [
  "记录类型", "权限口径", "来源系统", "平台", "业务统计起始", "业务统计截止",
  "批次源更新时间", "导出时间",
  "当前部署已选", "维度", "维度值", "币种", "有效行数", "计费金额",
  "支付金额", "支付-计费", "正向支付金额", "冲销/退回金额", "负数行数",
  "源行数", "staging行数", "无效行数", "运行ID", "导入任务ID", "门禁状态",
];

function evidenceRow(
  signal: JiandaoyunPlatformFeeObservation,
  generatedAt: string,
  recordType: string,
  dimension: string,
  row: PlatformFeeDimensionRow,
): (string | number | null | undefined)[] {
  return [
    recordType,
    signal.authority,
    signal.source,
    signal.platform,
    signal.businessDateFrom,
    signal.businessDateThrough,
    signal.sourceAsOf,
    generatedAt,
    signal.selectedForSync ? "是" : "否",
    dimension,
    row.key,
    row.currency,
    row.rows,
    row.billingAmount,
    row.paidAmount,
    row.billingPaidDelta,
    row.positivePaidAmount,
    row.reversalPaidAmount,
    row.negativeRows,
    signal.totals.sourceRows,
    signal.totals.stagedRows,
    signal.totals.invalidRows,
    signal.runId,
    signal.importJobId,
    signal.gate,
  ];
}

/**
 * 财务 UAT 控制表：金额仍为 decimal 字符串，按币种、月份、店铺和费用项逐层可回查。
 */
export function buildPlatformFeeUatExport(
  signal: JiandaoyunPlatformFeeObservation,
  now = new Date(),
): PlatformFeeCsvExport {
  const generatedAt = now.toISOString();
  const currencyRows: PlatformFeeDimensionRow[] = signal.currencies.map((row) => ({
    key: row.currency,
    ...row,
  }));
  return {
    filename: `简道云-天猫平台费用-UAT核对-${signal.businessDateThrough ?? "未注明统计截止"}-${exportTimestamp(now)}.csv`,
    headers: HEADERS,
    rows: [
      ...currencyRows.map((row) => evidenceRow(signal, generatedAt, "currency_control", "币种", row)),
      ...signal.monthly.map((row) => evidenceRow(signal, generatedAt, "monthly_control", "月份", row)),
      ...signal.shops.map((row) => evidenceRow(signal, generatedAt, "shop_control", "店铺", row)),
      ...signal.feeItems.map((row) => evidenceRow(signal, generatedAt, "fee_item_control", "费用项", row)),
    ],
  };
}
