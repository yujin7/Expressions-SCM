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
  "日期", "支付件数", "成功退款件数", "净需求信号", "已映射净需求", "放行状态",
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
      row.date, row.paidQty, row.refundQty, row.netQty, row.mappedNetQty, signal.gate,
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
