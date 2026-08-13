import {
  DATA_PRODUCT_AUTHORITY_LABEL,
  DATA_PRODUCT_CADENCE_LABEL,
  DATA_PRODUCT_SOURCE_LABEL,
  dataProductStreamLabel,
  type DataProductDefinition,
} from "@/components/data-products";
import {
  currentProductAutomation,
  evaluateProductSourceEvidence,
} from "@/components/data-product-source-evidence";
import {
  buildDataProductWorkQueue,
  type DataProductWorkStage,
} from "@/components/data-product-work-queue";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";

export interface DataProductEvidenceCsvExport {
  filename: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

const STAGE_LABEL: Record<DataProductWorkStage, string> = {
  safeguard: "先止损",
  approval: "待会签",
  release_ready: "可验收放行",
  repair: "修复证据",
  monitor: "持续监控",
};

const RELEASE_STATUS_LABEL = {
  pending: "待会签",
  approved: "已批准",
  rejected: "已拒绝",
  revoked: "已撤回",
} as const;

const HEADERS = [
  "记录类型", "导出时间", "数据产品ID", "数据产品", "产品契约版本", "要回答的决策", "决策粒度",
  "Owner", "责任角色", "决策SLA小时", "刷新节奏", "目标权威级", "自动化上限", "运行时级别", "当前有效级别",
  "处置阶段", "下一个最佳动作", "行动入口", "首要阻塞", "共同可比截止", "最新来源日期", "跨源时点跨度天数",
  "时效敏感流数", "缺业务日期流数", "来源系统", "来源技术键", "来源当前状态", "来源配置仍有效",
  "所需数据流", "数据流技术键", "流证据状态", "受限原因", "业务截止", "最近成功", "源行", "Staging行",
  "拒收行", "结构漂移", "观察层阻断", "当前放行记录状态", "放行目标级别",
];

function exportTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * 将当前数据产品目录、逐流运行证据、共同业务截止与放行台账压成一份可签核快照。
 * 不导出凭据、连接范围指纹、原始值或 staging payload；技术键保留用于回查。
 */
export function buildDataProductEvidenceExport(
  products: readonly DataProductDefinition[],
  dataSources: readonly DataSourceReadiness[],
  releases: readonly DataProductReleaseReadiness[],
  now = new Date(),
): DataProductEvidenceCsvExport {
  const generatedAt = now.toISOString();
  const releaseByProduct = new Map(releases.map((release) => [release.productId, release]));
  const workByProduct = new Map(
    buildDataProductWorkQueue(products, dataSources, releases).map((item) => [item.productId, item]),
  );
  const rows = products.flatMap((product) => {
    const summary = evaluateProductSourceEvidence(product, dataSources);
    const runtime = currentProductAutomation(summary);
    const release = releaseByProduct.get(product.id);
    const work = workByProduct.get(product.id);
    const releaseRecord = release?.activeRelease ?? release?.pendingRelease ?? release?.latestRelease ?? null;
    return summary.sources.flatMap((source) => source.streams.map((stream) => {
      const evidence = stream.evidence;
      const scmEvidence = stream.scmEvidence;
      return [
        "data_product_stream_evidence",
        generatedAt,
        product.id,
        product.title,
        product.contractVersion,
        product.decision,
        product.grain,
        product.owner,
        product.ownerRoles.join("/"),
        product.decisionSlaHours,
        DATA_PRODUCT_CADENCE_LABEL[product.cadence],
        DATA_PRODUCT_AUTHORITY_LABEL[product.targetAuthority],
        product.maxAutomation,
        runtime.level,
        release?.effectiveLevel ?? runtime.level,
        work ? STAGE_LABEL[work.stage] : "",
        work?.nextAction ?? "",
        work?.actionHref ?? "",
        work?.bottleneck ?? "",
        summary.businessTimeWindow.commonAsOf,
        summary.businessTimeWindow.latestAsOf,
        summary.businessTimeWindow.spanDays,
        summary.businessTimeWindow.timeSensitiveStreams,
        summary.businessTimeWindow.undatedStreams,
        DATA_PRODUCT_SOURCE_LABEL[source.source],
        source.source,
        source.state,
        source.configurationReady ? "是" : "否",
        dataProductStreamLabel(stream.source, stream.stream),
        stream.stream,
        stream.state,
        stream.reason,
        evidence?.sourceAsOf ?? scmEvidence?.asOf ?? null,
        evidence?.lastSuccessAt ?? null,
        evidence?.sourceRows ?? scmEvidence?.rows ?? 0,
        evidence?.stagedRows ?? null,
        evidence?.rejectedRows ?? null,
        evidence?.schemaDrift ? "是" : "否",
        evidence?.releaseBlocked ? "是" : "否",
        releaseRecord ? RELEASE_STATUS_LABEL[releaseRecord.status] : "无",
        releaseRecord?.targetLevel ?? null,
      ];
    }));
  });

  return {
    filename: `三方数据-产品决策证据-${exportTimestamp(now)}.csv`,
    headers: HEADERS,
    rows,
  };
}
