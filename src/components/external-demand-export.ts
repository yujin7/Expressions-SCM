import type { ExternalDemandSignal } from "@/server/modules/report/external-demand-signal";

export interface ExternalDemandCsvExport {
  filename: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

function exportTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function pct(value: number | null): string {
  return value == null ? "" : value.toFixed(1);
}

export function externalDemandIdentityAction(
  row: ExternalDemandSignal["topUnmapped"][number],
): "回源补对照/条码" | "去认领" | "已认领·待同步" | "已忽略·回源核对" | "待同步核对" {
  if (!row.barcode) return "回源补对照/条码";
  if (row.exceptionStatus === "open") return "去认领";
  if (row.exceptionStatus === "resolved") return "已认领·待同步";
  if (row.exceptionStatus === "ignored") return "已忽略·回源核对";
  return "待同步核对";
}

const DAILY_HEADERS = [
  "记录类型", "权限口径", "来源系统", "平台", "来源截止", "对照截止", "导出时间",
  "平台SKU身份数", "已映射身份数", "身份覆盖率%", "支付量覆盖率%", "质量问题数",
  "日期", "销售来源行数", "有效支付行数", "无效销售行数", "无效退款行数",
  "支付件数", "成功退款件数", "净需求信号", "已映射支付件数",
  "已映射退款件数", "已映射净需求", "放行状态",
];

/** 日控制总量证据：一行一个业务日期，所有口径/覆盖/截止日随行，不产生孤儿数字。 */
export function buildExternalDemandDailyExport(
  signal: ExternalDemandSignal,
  now = new Date(),
): ExternalDemandCsvExport {
  const generatedAt = now.toISOString();
  const qualityIssues = signal.quality.invalidSalesRows
    + signal.quality.invalidRefundRows
    + signal.quality.conflictingCrosswalks;
  return {
    filename: `简道云-天猫需求-UAT日核对-${signal.sourceAsOf ?? "未注明截止"}-${exportTimestamp(now)}.csv`,
    headers: DAILY_HEADERS,
    rows: signal.daily.map((row) => [
      "daily_control_total", signal.authority, signal.source, signal.platform,
      signal.sourceAsOf, signal.crosswalkAsOf, generatedAt,
      signal.coverage.platformIdentities, signal.coverage.mappedIdentities,
      pct(signal.coverage.identityPct), pct(signal.coverage.paidQtyPct), qualityIssues,
      row.date, row.sourceRows, row.validPaidRows, row.invalidSalesRows, row.invalidRefundRows,
      row.paidQty, row.refundQty, row.netQty,
      row.mappedPaidQty, row.mappedRefundQty, row.mappedNetQty, signal.gate,
    ]),
  };
}

const ROLLING_HEADERS = [
  "记录类型", "权限口径", "来源系统", "平台", "来源截止", "导出时间",
  "判断状态", "判断口径", "窗口", "开始日期", "结束日期", "观察天数", "要求天数",
  "支付件数", "成功退款件数", "净需求", "已映射支付件数", "已映射退款件数",
  "已映射净需求", "退款率%", "已映射支付覆盖率%", "支付量变化%", "净需求变化%",
  "退款率变化百分点", "已映射支付覆盖变化百分点",
];

/** 两个完整自然日窗口的决策证据；判断关闭时仍导出观察天数和门禁原因。 */
export function buildExternalDemandRollingBriefExport(
  signal: ExternalDemandSignal,
  now = new Date(),
): ExternalDemandCsvExport {
  const generatedAt = now.toISOString();
  const brief = signal.decisionBrief;
  const rows = [
    ["current_7d", brief.current],
    ["previous_7d", brief.previous],
  ] as const;
  return {
    filename: `简道云-天猫滚动需求简报-${brief.anchorDate ?? "无有效日期"}-${exportTimestamp(now)}.csv`,
    headers: ROLLING_HEADERS,
    rows: rows.map(([window, period]) => [
      "rolling_demand_brief",
      signal.authority,
      signal.source,
      signal.platform,
      signal.sourceAsOf,
      generatedAt,
      brief.state,
      brief.gate,
      window,
      period.startDate,
      period.endDate,
      period.observedDays,
      period.requiredDays,
      period.paidQty,
      period.refundQty,
      period.netQty,
      period.mappedPaidQty,
      period.mappedRefundQty,
      period.mappedNetQty,
      pct(period.refundRatePct),
      pct(period.mappedPaidCoveragePct),
      pct(brief.change.paidQtyPct),
      pct(brief.change.netQtyPct),
      pct(brief.change.refundRateDeltaPp),
      pct(brief.change.mappedPaidCoverageDeltaPp),
    ]),
  };
}

export function externalRefundDriverAction(
  row: ExternalDemandSignal["refundDrivers"]["topContributors"][number],
): "已映射·核查退款原因" | "回源补对照/条码" | "去认领" | "已认领·待同步" | "已忽略·回源核对" | "待同步核对" {
  if (row.skuId != null) return "已映射·核查退款原因";
  if (!row.barcode) return "回源补对照/条码";
  if (row.exceptionStatus === "open") return "去认领";
  if (row.exceptionStatus === "resolved") return "已认领·待同步";
  if (row.exceptionStatus === "ignored") return "已忽略·回源核对";
  return "待同步核对";
}

const REFUND_DRIVER_HEADERS = [
  "记录类型", "权限口径", "来源系统", "平台", "来源截止", "导出时间",
  "变化方向", "本期退款", "前期退款", "退款变化", "退款变化率%", "同向变化池",
  "可行动驱动数", "已映射驱动数", "未映射驱动数", "已映射变化池占比%",
  "排名", "店铺", "店铺同向池占比%", "平台SKU", "条码", "系统SKU ID", "商品名", "规格名",
  "本期支付", "本期退款", "本期退款率%", "前期支付", "前期退款", "前期退款率%",
  "退款量变化", "退款率变化百分点", "同向变化池占比%", "身份动作", "判断口径",
];

/** 退款变化行动证据：只导出与总体变化同方向的驱动，不把相互抵销后的净变化自动归责。 */
export function buildExternalDemandRefundDriversExport(
  signal: ExternalDemandSignal,
  now = new Date(),
): ExternalDemandCsvExport {
  const generatedAt = now.toISOString();
  const drivers = signal.refundDrivers;
  return {
    filename: `简道云-天猫退款驱动-${signal.decisionBrief.anchorDate ?? "无有效日期"}-${exportTimestamp(now)}.csv`,
    headers: REFUND_DRIVER_HEADERS,
    rows: drivers.topContributors.map((row, index) => [
      "refund_change_driver",
      drivers.authority,
      signal.source,
      signal.platform,
      signal.sourceAsOf,
      generatedAt,
      drivers.movement,
      drivers.totals.currentRefundQty,
      drivers.totals.previousRefundQty,
      drivers.totals.deltaRefundQty,
      pct(drivers.totals.changePct),
      drivers.totals.movementPoolQty,
      drivers.eligibleDrivers,
      drivers.identityCoverage.mappedDrivers,
      drivers.identityCoverage.unmappedDrivers,
      pct(drivers.identityCoverage.mappedMovementPoolPct),
      index + 1,
      row.shopName,
      pct(drivers.byShop.find((shop) => shop.shopName === row.shopName)?.movementPoolSharePct ?? null),
      row.platformSkuId,
      row.barcode,
      row.skuId,
      row.productName,
      row.skuName,
      row.currentPaidQty,
      row.currentRefundQty,
      pct(row.currentRefundRatePct),
      row.previousPaidQty,
      row.previousRefundQty,
      pct(row.previousRefundRatePct),
      row.deltaRefundQty,
      pct(row.refundRateDeltaPp),
      pct(row.movementPoolSharePct),
      externalRefundDriverAction(row),
      drivers.gate,
    ]),
  };
}

const IDENTITY_HEADERS = [
  "记录类型", "权限口径", "来源系统", "平台", "来源截止", "对照截止", "导出时间",
  "店铺", "平台SKU", "条码", "商品名", "规格名", "支付件数", "成功退款件数", "净需求",
  "异常单ID", "异常状态", "下一步动作", "放行状态",
];

/** 身份修复队列：严格导出当前 TOP 未映射记录，保留可回查的异常 ID 与确定性动作。 */
export function buildExternalDemandIdentityExport(
  signal: ExternalDemandSignal,
  now = new Date(),
): ExternalDemandCsvExport {
  const generatedAt = now.toISOString();
  return {
    filename: `简道云-天猫SKU身份修复-${signal.sourceAsOf ?? "未注明截止"}-${exportTimestamp(now)}.csv`,
    headers: IDENTITY_HEADERS,
    rows: signal.topUnmapped.map((row) => [
      "identity_repair", signal.authority, signal.source, signal.platform,
      signal.sourceAsOf, signal.crosswalkAsOf, generatedAt,
      row.shopName, row.platformSkuId, row.barcode, row.productName, row.skuName,
      row.paidQty, row.refundQty, row.netQty, row.exceptionId, row.exceptionStatus,
      externalDemandIdentityAction(row), signal.gate,
    ]),
  };
}

const FULFILLMENT_HEADERS = [
  "记录类型", "权限口径", "对比粒度", "简道云来源截止", "聚水潭来源截止", "导出时间",
  "日期", "系统SKU ID", "系统SKU编码", "简道云已映射净需求", "聚水潭实际出库",
  "差异（出库-净需求）", "绝对差异", "简道云可比覆盖率%", "聚水潭可比覆盖率%", "放行状态",
];

/** 跨源 UAT 明细：只导出同业务日、同 SCM SKU 的可比样本，不把单边缺失补成零。 */
export function buildExternalDemandFulfillmentExport(
  signal: ExternalDemandSignal,
  now = new Date(),
): ExternalDemandCsvExport {
  const generatedAt = now.toISOString();
  const comparison = signal.fulfillment;
  return {
    filename: `简道云-聚水潭-需求履约核对-${comparison.jstSourceAsOf ?? "无可比批次"}-${exportTimestamp(now)}.csv`,
    headers: FULFILLMENT_HEADERS,
    rows: comparison.topGaps.map((row) => [
      "demand_fulfillment_comparison",
      comparison.authority,
      comparison.grain,
      signal.sourceAsOf,
      comparison.jstSourceAsOf,
      generatedAt,
      row.date,
      row.skuId,
      row.skuCode,
      row.mappedNetDemandQty,
      row.jstOutboundQty,
      row.gapQty,
      row.absoluteGapQty,
      pct(comparison.coverage.jdyComparablePct),
      pct(comparison.coverage.jstComparablePct),
      comparison.gate,
    ]),
  };
}
