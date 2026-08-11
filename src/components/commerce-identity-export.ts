import type {
  CommerceIdentityCoverage,
  CommerceIdentityIssue,
} from "@/server/modules/report/commerce-identity-coverage";

export interface CommerceIdentityCsvExport {
  filename: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

export const COMMERCE_IDENTITY_ISSUE_LABEL: Record<CommerceIdentityIssue, string> = {
  conflicting_mapping: "多 SKU 归属冲突",
  conflicting_bridge: "桥接字段冲突",
  unmapped_with_bridge: "有桥未映射",
  missing_bridge: "缺桥接字段",
  duplicate_source: "重复来源记录",
};

function exportTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * 跨平台身份修复证据。只导出当前服务端按最新成功批次生成的确定性队列，
 * 不在浏览器按名称猜测、不把观察字段提升为主数据。
 */
export function buildCommerceIdentityRepairExport(
  coverage: CommerceIdentityCoverage,
  now = new Date(),
): CommerceIdentityCsvExport {
  const generatedAt = now.toISOString();
  const sourceAsOfByPlatform = new Map(
    coverage.platforms.map((item) => [item.key, item.sourceAsOf] as const),
  );
  return {
    filename: `简道云-三平台身份修复队列-${exportTimestamp(now)}.csv`,
    headers: [
      "记录类型", "权限口径", "来源系统", "平台", "来源截止", "导出时间",
      "优先级", "问题类型", "店铺", "平台商品或SKU", "商品名", "桥接字段",
      "桥接值", "源记录数", "可直接进入认领", "下一步动作", "放行状态",
    ],
    rows: coverage.repairQueue.map((row) => [
      "commerce_identity_repair",
      coverage.authority,
      coverage.source,
      row.platform,
      sourceAsOfByPlatform.get(row.platformKey) ?? null,
      generatedAt,
      `P${row.priority}`,
      COMMERCE_IDENTITY_ISSUE_LABEL[row.issue],
      row.shopName,
      row.externalId,
      row.productName,
      row.bridgeLabel,
      row.bridgeValue,
      row.sourceRows,
      row.claimable ? "是" : "否",
      row.action,
      coverage.gate,
    ]),
  };
}
