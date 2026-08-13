import {
  DATA_PRODUCT_SOURCE_LABEL,
  dataProductStreamLabel,
  type DataProductDefinition,
  type DataProductSource,
} from "@/components/data-products";
import {
  evaluateExternalStreamEvidence,
  type ProductStreamEvidenceState,
} from "@/components/data-product-source-evidence";
import type { DataSourceReadiness, DataStreamEvidence } from "@/server/modules/report/data-source-readiness";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";

type ExternalSource = Exclude<DataProductSource, "SCM">;

export type DataAssetDecisionState = ProductStreamEvidenceState | "observation";
export type DataAssetImplementationState = "implemented" | "planned" | "unknown";

export interface DataAssetDecisionDependency {
  productId: string;
  title: string;
  decision: string;
  owner: string;
  decisionSlaHours: number;
  effectiveLevel: "A0" | "A1" | "A2" | "A3";
}

export interface DataAssetDecisionCoverageRow {
  key: string;
  source: ExternalSource;
  sourceLabel: string;
  stream: string;
  streamLabel: string;
  state: DataAssetDecisionState;
  stateReason: string;
  explanationUsable: boolean;
  implementationState: DataAssetImplementationState;
  cataloged: boolean;
  dependencies: DataAssetDecisionDependency[];
  dependencyCount: number;
  releasedDependencyCount: number;
  minDecisionSlaHours: number | null;
  evidence: DataStreamEvidence | null;
  actionLabel: string;
  actionHref: string;
}

export interface DataAssetSourceCoverage {
  source: ExternalSource;
  sourceLabel: string;
  requiredAssetCount: number;
  implementedAssetCount: number;
  plannedAssetCount: number;
  explanationUsableCount: number;
  operationalReadyCount: number;
  unusedObservedCount: number;
  affectedProductCount: number;
}

export interface DataAssetDecisionPortfolio {
  rows: DataAssetDecisionCoverageRow[];
  sources: DataAssetSourceCoverage[];
  requiredAssetCount: number;
  implementedAssetCount: number;
  plannedAssetCount: number;
  explanationUsableCount: number;
  operationalReadyCount: number;
  unusedObservedCount: number;
  affectedProductCount: number;
}

const EXTERNAL_SOURCES: readonly ExternalSource[] = ["JIANDAOYUN", "JST", "YONYOU"];
const IDENTITY_STREAMS = new Set([
  "tmall-sku-crosswalk-observation",
  "pdd-sku-crosswalk-observation",
  "vip-product-crosswalk-observation",
  "item-master",
]);

const STATE_ORDER: Record<DataAssetDecisionState, number> = {
  degraded: 0,
  stale: 1,
  missing: 2,
  observation: 3,
  current: 4,
};

const IMPLEMENTATION_ORDER: Record<DataAssetImplementationState, number> = {
  planned: 0,
  unknown: 1,
  implemented: 2,
};

function usableForExplanation(evidence: DataStreamEvidence | null): boolean {
  return evidence != null
    && evidence.selectedForSync !== false
    && evidence.lastSuccessAt != null
    && evidence.latestStatus === "succeeded"
    && evidence.freshness === "current"
    && evidence.sourceAsOf != null
    && !evidence.authorizationBlocked
    && !evidence.sourceTimeInvalid
    && !evidence.schemaDrift
    && !evidence.emptySource
    && evidence.rejectedRows === 0
    && evidence.quality?.status !== "review";
}

function sourceCanExplain(sourceRow: DataSourceReadiness | undefined): boolean {
  return sourceRow?.configurationReady === true
    && (sourceRow.state === "observation" || sourceRow.state === "operational");
}

function assetState(
  state: ProductStreamEvidenceState,
  evidence: DataStreamEvidence | null,
  sourceRow: DataSourceReadiness | undefined,
  implementationState: DataAssetImplementationState,
): { state: DataAssetDecisionState; reason: string | null } {
  if (implementationState === "planned") {
    return evidence?.lastSuccessAt
      ? { state: "degraded", reason: "历史运行仍可追溯，但当前代码没有登记这条受控读取契约，不能继续用于决策" }
      : { state: "missing", reason: "数据产品已声明需要该流，但当前代码尚未实现受控读取契约" };
  }
  if (evidence?.selectedForSync === false) {
    return {
      state: evidence.lastSuccessAt ? "degraded" : "missing",
      reason: evidence.lastSuccessAt
        ? "历史/手工演练证据仍可追溯，但当前部署未显式选中该流，不能用于持续决策"
        : "读取契约已实现，但当前部署未显式选中该流",
    };
  }
  if (evidence?.lastSuccessAt && sourceRow?.configurationReady !== true) {
    return { state: "degraded", reason: "历史批次仍可追溯，但当前凭据、契约或连接范围已失效，不能继续用于决策" };
  }
  if (
    evidence?.lastSuccessAt
    && sourceRow != null
    && sourceRow.state !== "observation"
    && sourceRow.state !== "operational"
  ) {
    return { state: "degraded", reason: "历史批次仍可追溯，但来源当前未进入观察或运营状态，不能继续用于决策" };
  }
  // releaseBlocked means the evidence is deliberately observation-only. When every
  // other runtime/quality gate is clean, distinguish that safe A1 input from a broken stream.
  if (
    usableForExplanation(evidence)
    && (evidence?.releaseBlocked || sourceRow?.state !== "operational")
  ) {
    return {
      state: "observation",
      reason: "当前成功证据可用于带口径解释；来源仍停在观察层，需控制总量、UAT 与会签",
    };
  }
  return { state, reason: null };
}

function productEvidenceHref(productId: string): string {
  return `/report/decision-studio?tab=readiness&product=${encodeURIComponent(productId)}#data-product-${encodeURIComponent(productId)}`;
}

function actionFor(
  source: ExternalSource,
  stream: string,
  state: DataAssetDecisionState,
  dependencies: readonly DataAssetDecisionDependency[],
  sourceRow: DataSourceReadiness | undefined,
  implementationState: DataAssetImplementationState,
): Pick<DataAssetDecisionCoverageRow, "actionLabel" | "actionHref"> {
  if (implementationState === "planned") {
    return { actionLabel: "补齐读取契约", actionHref: "/admin/health" };
  }
  if (
    state !== "current"
    && state !== "observation"
    && IDENTITY_STREAMS.has(stream)
    && (sourceRow?.openIdentityExceptions ?? 0) > 0
  ) {
    return {
      actionLabel: "处理身份异常",
      actionHref: `/import/exceptions?status=open&scope=${encodeURIComponent(source)}`,
    };
  }
  if (state === "missing" || state === "stale" || state === "degraded") {
    return { actionLabel: "修复连接证据", actionHref: "/admin/health" };
  }
  if (dependencies.length === 0) {
    return { actionLabel: "评估资产用途", actionHref: "/report/decision-studio?tab=readiness" };
  }
  return {
    actionLabel: state === "observation" ? "完成产品 UAT" : "查看产品门禁",
    actionHref: productEvidenceHref(dependencies[0].productId),
  };
}

/**
 * 把连接器逐流证据反向映射到数据产品与业务决策。
 *
 * 这不是价值打分：排序只使用可观测状态、目录声明的决策 SLA、受影响产品数和稳定名称。
 * 运行时成功但未被目录引用的流会显式列为“未编入产品”，避免数据接入后无人使用。
 */
export function buildDataAssetDecisionPortfolio(
  products: readonly DataProductDefinition[],
  dataSources: readonly DataSourceReadiness[],
  releases: readonly DataProductReleaseReadiness[] = [],
): DataAssetDecisionPortfolio {
  const sourceByKey = new Map(dataSources.map((source) => [source.key, source]));
  const releaseByProduct = new Map(releases.map((release) => [release.productId, release]));
  const rows: DataAssetDecisionCoverageRow[] = [];

  for (const source of EXTERNAL_SOURCES) {
    const sourceRow = sourceByKey.get(source);
    const dependenciesByStream = new Map<string, DataProductDefinition[]>();
    for (const product of products) {
      for (const stream of product.requiredStreams[source] ?? []) {
        const dependencies = dependenciesByStream.get(stream) ?? [];
        dependencies.push(product);
        dependenciesByStream.set(stream, dependencies);
      }
    }
    const runtimeStreams = sourceRow?.streams?.map((stream) => stream.stream) ?? [];
    const streamKeys = [...new Set([...dependenciesByStream.keys(), ...runtimeStreams])];
    for (const stream of streamKeys) {
      const evaluated = evaluateExternalStreamEvidence(source, stream, sourceRow);
      const implementationState: DataAssetImplementationState = sourceRow?.availableStreamKeys == null
        ? "unknown"
        : sourceRow.availableStreamKeys.includes(stream) ? "implemented" : "planned";
      const dependencies = (dependenciesByStream.get(stream) ?? [])
        .map<DataAssetDecisionDependency>((product) => ({
          productId: product.id,
          title: product.title,
          decision: product.decision,
          owner: product.owner,
          decisionSlaHours: product.decisionSlaHours,
          effectiveLevel: releaseByProduct.get(product.id)?.effectiveLevel ?? "A0",
        }))
        .sort((a, b) => a.decisionSlaHours - b.decisionSlaHours || a.title.localeCompare(b.title, "zh-CN"));
      const evaluatedAsset = assetState(
        evaluated.state,
        evaluated.evidence,
        sourceRow,
        implementationState,
      );
      const state = evaluatedAsset.state;
      const action = actionFor(
        source,
        stream,
        state,
        dependencies,
        sourceRow,
        implementationState,
      );
      rows.push({
        key: `${source}:${stream}`,
        source,
        sourceLabel: DATA_PRODUCT_SOURCE_LABEL[source],
        stream,
        streamLabel: dataProductStreamLabel(source, stream),
        state,
        stateReason: evaluatedAsset.reason ?? evaluated.reason,
        explanationUsable: implementationState !== "planned"
          && sourceCanExplain(sourceRow)
          && usableForExplanation(evaluated.evidence),
        implementationState,
        cataloged: dependencies.length > 0,
        dependencies,
        dependencyCount: dependencies.length,
        releasedDependencyCount: dependencies.filter((item) => item.effectiveLevel === "A2" || item.effectiveLevel === "A3").length,
        minDecisionSlaHours: dependencies[0]?.decisionSlaHours ?? null,
        evidence: evaluated.evidence,
        ...action,
      });
    }
  }

  rows.sort((a, b) => {
    const catalog = Number(b.cataloged) - Number(a.cataloged);
    if (catalog !== 0) return catalog;
    const state = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (state !== 0) return state;
    const implementation = IMPLEMENTATION_ORDER[a.implementationState]
      - IMPLEMENTATION_ORDER[b.implementationState];
    if (implementation !== 0) return implementation;
    const sla = (a.minDecisionSlaHours ?? Number.MAX_SAFE_INTEGER) - (b.minDecisionSlaHours ?? Number.MAX_SAFE_INTEGER);
    if (sla !== 0) return sla;
    const dependencies = b.dependencyCount - a.dependencyCount;
    if (dependencies !== 0) return dependencies;
    return a.key.localeCompare(b.key);
  });

  const sourceSummaries = EXTERNAL_SOURCES.map<DataAssetSourceCoverage>((source) => {
    const sourceRows = rows.filter((row) => row.source === source);
    const requiredRows = sourceRows.filter((row) => row.cataloged);
    const affectedProducts = new Set(
      requiredRows
        .filter((row) => row.state !== "current")
        .flatMap((row) => row.dependencies.map((dependency) => dependency.productId)),
    );
    return {
      source,
      sourceLabel: DATA_PRODUCT_SOURCE_LABEL[source],
      requiredAssetCount: requiredRows.length,
      implementedAssetCount: requiredRows.filter((row) => row.implementationState === "implemented").length,
      plannedAssetCount: requiredRows.filter((row) => row.implementationState === "planned").length,
      explanationUsableCount: requiredRows.filter((row) => row.explanationUsable).length,
      operationalReadyCount: requiredRows.filter((row) => row.state === "current").length,
      unusedObservedCount: sourceRows.filter((row) => !row.cataloged && row.explanationUsable).length,
      affectedProductCount: affectedProducts.size,
    };
  });
  const requiredRows = rows.filter((row) => row.cataloged);
  return {
    rows,
    sources: sourceSummaries,
    requiredAssetCount: requiredRows.length,
    implementedAssetCount: requiredRows.filter((row) => row.implementationState === "implemented").length,
    plannedAssetCount: requiredRows.filter((row) => row.implementationState === "planned").length,
    explanationUsableCount: requiredRows.filter((row) => row.explanationUsable).length,
    operationalReadyCount: requiredRows.filter((row) => row.state === "current").length,
    unusedObservedCount: rows.filter((row) => !row.cataloged && row.explanationUsable).length,
    affectedProductCount: new Set(
      requiredRows
        .filter((row) => row.state !== "current")
        .flatMap((row) => row.dependencies.map((dependency) => dependency.productId)),
    ).size,
  };
}
