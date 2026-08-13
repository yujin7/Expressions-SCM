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
  evaluateProductSupportingEvidence,
} from "@/components/data-product-source-evidence";
import {
  buildDataProductWorkQueue,
  summarizeDataProductLearning,
  type DataProductWorkStage,
} from "@/components/data-product-work-queue";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import type { DataProductOutcomeReadiness } from "@/server/modules/report/data-product-outcome";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";
import { METRIC_COMPUTATION_STATE_LABEL } from "@/lib/data-product-metric-lineage";

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
  learning: "真实结果学习",
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
  "上游产品门禁", "未满足上游产品数",
  "处置阶段", "下一个最佳动作", "行动入口", "首要阻塞", "共同可比截止", "最新来源日期", "跨源时点跨度天数",
  "时效敏感流数", "缺业务日期流数", "证据用途", "来源系统", "来源技术键", "来源当前状态", "来源配置仍有效",
  "数据流", "数据流技术键", "流证据状态", "受限原因", "业务截止", "最近成功", "源行", "Staging行",
  "拒收行", "结构漂移", "观察层阻断", "聚合质量状态", "业务键缺失行", "重复键组", "重复键行",
  "非法数值", "对账差异行", "对账覆盖不足行", "当前放行记录状态", "放行目标级别",
  "结果学习状态", "真实结果有效记录数", "已评价决策数", "采纳数", "待观察数", "已形成结果数", "误报数",
  "采纳率%", "误报率%", "平均处理分钟", "实际节省工时", "现金影响可见", "实际现金影响CNY",
  "最新结果决策编号", "最新结果业务日", "最新业务决定", "最新真实结果",
  "辅助历史摘要", "辅助历史期间", "辅助身份认领覆盖",
  "身份维度", "身份治理方式", "身份状态", "身份候选数", "身份已认领数",
  "身份开放异常数", "身份忽略数", "身份下一步", "身份提取契约状态",
  "身份适用数据流", "身份提取契约说明", "身份提取契约下一步",
  "业务语义门禁", "源业务粒度", "本产品使用语义", "业务语义说明", "业务语义下一步",
  "指标技术键", "指标名称", "指标计算状态", "指标输出粒度", "指标输入血缘",
  "指标连接键", "指标缺失策略", "指标计算实证", "指标下一步",
];

const OUTCOME_DECISION_LABEL = {
  accepted: "采纳",
  modified: "修改后采纳",
  rejected: "拒绝",
  deferred: "暂缓",
} as const;

const OUTCOME_RESULT_LABEL = {
  pending: "待观察",
  positive: "正向",
  neutral: "中性",
  negative: "负向",
  false_positive: "误报",
} as const;

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
  outcomes: readonly DataProductOutcomeReadiness[] = [],
  now = new Date(),
  supportingObservations: readonly JiandaoyunSupportingObservation[] = [],
): DataProductEvidenceCsvExport {
  const generatedAt = now.toISOString();
  const releaseByProduct = new Map(releases.map((release) => [release.productId, release]));
  const outcomeByProduct = new Map(outcomes.map((outcome) => [outcome.productId, outcome]));
  const observationByStream = new Map(supportingObservations.map((item) => [item.stream, item]));
  const workByProduct = new Map(
    buildDataProductWorkQueue(products, dataSources, releases, outcomes).map((item) => [item.productId, item]),
  );
  const rows = products.flatMap((product) => {
    const summary = evaluateProductSourceEvidence(product, dataSources);
    const runtime = currentProductAutomation(summary);
    const release = releaseByProduct.get(product.id);
    const outcome = outcomeByProduct.get(product.id);
    const learning = summarizeDataProductLearning(outcome);
    const latestOutcome = outcome?.latest[0] ?? null;
    const work = workByProduct.get(product.id);
    const releaseRecord = release?.activeRelease ?? release?.pendingRelease ?? release?.latestRelease ?? null;
    const productDependencyGate = (release?.dependencyGates ?? []).map((dependency) =>
      `${dependency.title}≥${dependency.minimumLevel}:${dependency.satisfied ? "已满足" : `未满足(当前${dependency.effectiveLevel})`}`
    ).join("；") || "无";
    const unsatisfiedProductDependencies = (release?.dependencyGates ?? [])
      .filter((dependency) => !dependency.satisfied).length;
    const requiredRows = summary.sources.flatMap((source) => source.streams.map((stream) => ({
      source: {
        source: source.source,
        state: source.state,
        configurationReady: source.configurationReady,
      },
      stream,
      usage: "放行依赖",
      identity: null,
      metricLineage: null,
    })));
    const supportingRows = evaluateProductSupportingEvidence(product, dataSources).map((stream) => {
      const readiness = dataSources.find((source) => source.key === stream.source);
      return {
        source: {
          source: stream.source,
          state: readiness?.state ?? "missing",
          configurationReady: readiness?.configurationReady === true,
        },
        stream,
        usage: "辅助证据（不参与放行）",
        identity: null,
        metricLineage: null,
      };
    });
    const identityRows = summary.identityGates.map((identity) => {
      const readiness = dataSources.find((source) => source.key === identity.source);
      return {
        source: {
          source: identity.source,
          state: readiness?.state ?? "missing",
          configurationReady: readiness?.configurationReady === true,
        },
        stream: null,
        usage: "身份门禁",
        identity,
        metricLineage: null,
      };
    });
    const scmReadiness = dataSources.find((source) => source.key === "SCM");
    const metricRows = summary.metricGates.map((metricLineage) => ({
      source: {
        source: "SCM" as const,
        state: scmReadiness?.state ?? "missing" as const,
        configurationReady: scmReadiness?.configurationReady === true,
      },
      stream: null,
      usage: "指标计算血缘",
      identity: null,
      metricLineage,
    }));
    return [...requiredRows, ...supportingRows, ...identityRows, ...metricRows].map(({
      source, stream, usage, identity, metricLineage,
    }) => {
      const evidence = stream?.evidence ?? null;
      const scmEvidence = stream?.scmEvidence;
      const observation = stream && usage === "辅助证据（不参与放行）" && source.source === "JIANDAOYUN"
        ? observationByStream.get(stream.stream as JiandaoyunSupportingObservation["stream"])
        : undefined;
      const observationPeriod = observation?.businessDateFrom && observation.businessDateThrough
        ? `${observation.businessDateFrom} 至 ${observation.businessDateThrough}`
        : observation?.sourceAsOf ?? null;
      const observationIdentity = observation?.identityCoverage.map((item) =>
        `${item.label} ${item.governedMatches}/${item.distinctValues}（待认领 ${item.openValues}，已入队 ${item.queuedValues}，未入队 ${item.unqueuedValues}）`
      ).join(" · ") || null;
      const semanticControls = stream
        ? summary.semanticGates.filter((item) =>
            item.source === stream.source && item.stream === stream.stream)
        : [];
      const semanticBlockers = semanticControls.filter((item) => item.state !== "implemented");
      const semanticState = semanticControls.length === 0
        ? null
        : semanticBlockers.length === 0 ? "implemented" : semanticBlockers[0].state;
      return [
        metricLineage
          ? "data_product_metric_lineage"
          : identity ? "data_product_identity_evidence" : "data_product_stream_evidence",
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
        productDependencyGate,
        unsatisfiedProductDependencies,
        work ? STAGE_LABEL[work.stage] : "",
        work?.nextAction ?? "",
        work?.actionHref ?? "",
        work?.bottleneck ?? "",
        summary.businessTimeWindow.commonAsOf,
        summary.businessTimeWindow.latestAsOf,
        summary.businessTimeWindow.spanDays,
        summary.businessTimeWindow.timeSensitiveStreams,
        summary.businessTimeWindow.undatedStreams,
        usage,
        DATA_PRODUCT_SOURCE_LABEL[source.source],
        source.source,
        source.state,
        source.configurationReady ? "是" : "否",
        identity?.label ?? (stream ? dataProductStreamLabel(stream.source, stream.stream) : null),
        identity ? `identity:${identity.domain}` : stream?.stream ?? null,
        identity?.state ?? stream?.state ?? null,
        identity?.reason ?? stream?.reason ?? null,
        evidence?.sourceAsOf ?? scmEvidence?.asOf ?? null,
        evidence?.lastSuccessAt ?? null,
        evidence?.sourceRows ?? scmEvidence?.rows ?? 0,
        evidence?.stagedRows ?? null,
        evidence?.rejectedRows ?? null,
        evidence?.schemaDrift ? "是" : "否",
        evidence?.releaseBlocked ? "是" : "否",
        evidence?.quality?.status === "pass"
          ? "通过"
          : evidence?.quality?.status === "review" ? "待复核" : "未固化",
        evidence?.quality?.missingBusinessKeyRows ?? null,
        evidence?.quality?.duplicateKeyGroups ?? null,
        evidence?.quality?.duplicateRows ?? null,
        evidence?.quality?.invalidNumericValues ?? null,
        evidence?.quality?.reconciliationMismatchedRows ?? null,
        evidence?.quality?.reconciliationInsufficientRows ?? null,
        releaseRecord ? RELEASE_STATUS_LABEL[releaseRecord.status] : "无",
        releaseRecord?.targetLevel ?? null,
        learning.label,
        outcome?.outcomeCount ?? null,
        outcome?.evaluatedDecisionCount ?? null,
        outcome?.adoptedCount ?? null,
        outcome?.pendingCount ?? null,
        outcome?.terminalResultCount ?? null,
        outcome?.falsePositiveCount ?? null,
        outcome?.adoptionRatePct ?? null,
        outcome?.falsePositiveRatePct ?? null,
        outcome?.avgHandlingMinutes ?? null,
        outcome?.savedHoursTotal ?? null,
        outcome ? (outcome.cashVisible ? "是" : "按角色隐藏") : null,
        outcome?.cashVisible ? outcome.cashImpactTotal : null,
        latestOutcome?.decisionRef ?? null,
        latestOutcome?.businessDate ?? null,
        latestOutcome ? OUTCOME_DECISION_LABEL[latestOutcome.decision] : null,
        latestOutcome ? OUTCOME_RESULT_LABEL[latestOutcome.result] : null,
        observation?.summary ?? null,
        observationPeriod,
        observationIdentity,
        identity?.label ?? null,
        identity?.evidence?.governance ?? null,
        identity?.state ?? null,
        identity?.evidence?.observed ?? null,
        identity?.evidence?.governed ?? null,
        identity?.evidence?.open ?? null,
        identity?.evidence?.ignored ?? null,
        identity?.nextAction ?? null,
        identity?.extractionState ?? null,
        identity?.extractionStreams.map((item) =>
          `${dataProductStreamLabel(identity.source, item.stream)}[${item.state}]`).join("；") ?? null,
        identity?.extractionReason ?? null,
        identity?.extractionNextAction ?? null,
        semanticState,
        semanticControls[0]?.grain ?? null,
        semanticControls.map((item) => `${item.label}[${item.state}]`).join("；") || null,
        semanticControls.map((item) => `${item.label}：${item.reason}`).join("；") || null,
        semanticBlockers.map((item) => `${item.label}：${item.nextAction}`).join("；") || null,
        metricLineage?.metricId ?? null,
        metricLineage?.label ?? null,
        metricLineage ? METRIC_COMPUTATION_STATE_LABEL[metricLineage.state] : null,
        metricLineage?.outputGrain ?? null,
        metricLineage?.inputs.map((input) =>
          `${input.kind}:${input.source ? `${input.source}:` : ""}${input.ref}(${input.purpose})`
        ).join("；") ?? null,
        metricLineage?.joinKeys.join("；") ?? null,
        metricLineage?.missingPolicy ?? null,
        metricLineage?.reason ?? null,
        metricLineage?.nextAction ?? null,
      ];
    });
  });

  return {
    filename: `三方数据-产品决策证据-${exportTimestamp(now)}.csv`,
    headers: HEADERS,
    rows,
  };
}
