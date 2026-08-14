import {
  DATA_PRODUCTS,
  DATA_PRODUCT_SOURCE_LABEL,
  dataProductStreamLabel,
  type DataProductSource,
} from "@/components/data-products";
import {
  currentProductAutomation,
  evaluateProductSourceEvidence,
  type ProductSourceEvidenceState,
  type ProductStreamEvidenceState,
} from "@/components/data-product-source-evidence";
import type { CrossSystemIdentityState } from "@/lib/cross-system-identity";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";

type ExternalSource = Exclude<DataProductSource, "SCM">;

export interface ProductExternalDecisionStreamBrief {
  stream: string;
  label: string;
  state: ProductStreamEvidenceState;
  reason: string;
  sourceAsOf: string | null;
  lastSuccessAt: string | null;
  sourceRows: number | null;
  rejectedRows: number | null;
}

export interface ProductExternalDecisionIdentityBrief {
  label: string;
  state: CrossSystemIdentityState;
}

export interface ProductExternalDecisionSourceBrief {
  source: ExternalSource;
  label: string;
  state: ProductSourceEvidenceState;
  configurationReady: boolean;
  streams: ProductExternalDecisionStreamBrief[];
  identities: ProductExternalDecisionIdentityBrief[];
}

export interface ProductExternalDecisionEvidenceBrief {
  productId: string;
  title: string;
  decision: string;
  inputLevel: "A0" | "A1";
  blockerSummary: string;
  sources: ProductExternalDecisionSourceBrief[];
  detailHref: string;
}

function blockerSummary(
  summary: ReturnType<typeof evaluateProductSourceEvidence>,
  inputLevel: "A0" | "A1",
): string {
  if (inputLevel === "A1") {
    return "外部输入已达到带来源口径的解释层；产品级控制总量、UAT、会签与回滚证据仍需单独放行。";
  }
  const parts = [
    summary.missingStreams > 0 ? `缺少 ${summary.missingStreams} 条必需流` : null,
    summary.staleStreams > 0 ? `${summary.staleStreams} 条流已过期` : null,
    summary.degradedStreams > 0 ? `${summary.degradedStreams} 条流受限` : null,
    summary.missingIdentities + summary.partialIdentities + summary.unimplementedIdentities > 0
      ? `${summary.missingIdentities + summary.partialIdentities + summary.unimplementedIdentities} 个身份门禁未闭合`
      : null,
    summary.unreadyExtractionIdentities > 0 ? `${summary.unreadyExtractionIdentities} 个逐流身份提取未就绪` : null,
    summary.unreadySemantics > 0 ? `${summary.unreadySemantics} 项业务语义待固化` : null,
    summary.unreadyMetrics > 0 ? `${summary.unreadyMetrics} 项指标计算待实现或验证` : null,
  ].filter((item): item is string => item !== null);
  return parts.length > 0
    ? `${parts.join("；")}。数据未到或未通过门禁均保持未知，不按 0 处理。`
    : "外部输入尚未达到解释层；请进入决策证据查看逐流原因。";
}

/**
 * 给业务页面的最小跨系统证据摘要。只保留状态、控制量和日期，不返回外部原值、凭据或原始响应。
 */
export function buildProductExternalDecisionEvidenceBrief(
  productId: string,
  dataSources: readonly DataSourceReadiness[],
): ProductExternalDecisionEvidenceBrief {
  const product = DATA_PRODUCTS.find((item) => item.id === productId);
  if (!product) throw new Error(`未知数据产品：${productId}`);
  const summary = evaluateProductSourceEvidence(product, dataSources);
  const automation = currentProductAutomation(summary);
  const sources = summary.sources
    .filter((source): source is typeof source & { source: ExternalSource } => source.source !== "SCM")
    .map<ProductExternalDecisionSourceBrief>((source) => ({
      source: source.source,
      label: DATA_PRODUCT_SOURCE_LABEL[source.source],
      state: source.state,
      configurationReady: source.configurationReady,
      streams: source.streams.map((stream) => ({
        stream: stream.stream,
        label: dataProductStreamLabel(source.source, stream.stream),
        state: stream.state,
        reason: stream.reason,
        sourceAsOf: stream.evidence?.sourceAsOf ?? null,
        lastSuccessAt: stream.evidence?.lastSuccessAt ?? null,
        sourceRows: stream.evidence?.sourceRows ?? null,
        rejectedRows: stream.evidence?.rejectedRows ?? null,
      })),
      identities: summary.identityGates
        .filter((identity) => identity.source === source.source)
        .map((identity) => ({ label: identity.label, state: identity.state })),
    }));
  return {
    productId: product.id,
    title: product.title,
    decision: product.decision,
    inputLevel: automation.level,
    blockerSummary: blockerSummary(summary, automation.level),
    sources,
    detailHref: `/report/decision-studio?tab=readiness&product=${encodeURIComponent(product.id)}#data-product-${encodeURIComponent(product.id)}`,
  };
}
