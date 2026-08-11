import type { DataProductDefinition, DataProductSource } from "@/components/data-products";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";

export type ProductSourceEvidenceState = "missing" | "observation" | "operational";

export interface ProductSourceEvidence {
  source: DataProductSource;
  state: ProductSourceEvidenceState;
  missingStreams: string[];
}

export interface ProductEvidenceSummary {
  sources: ProductSourceEvidence[];
  observedSources: number;
  operationalSources: number;
  missingSources: number;
  missingStreams: number;
}

/**
 * 数据产品就绪度必须同时命中「来源 + 该产品需要的具体数据流」。
 * 同一连接器的目录、库存或其他无关流不能为产品代打通行证明。
 */
export function evaluateProductSourceEvidence(
  product: DataProductDefinition,
  dataSources: readonly DataSourceReadiness[],
): ProductEvidenceSummary {
  const sourceByKey = new Map(dataSources.map((row) => [row.key, row]));
  const sources = product.sources.map<ProductSourceEvidence>((source) => {
    const row = sourceByKey.get(source);
    const requiredStreams = product.requiredStreams[source] ?? [];
    const missingStreams = source === "SCM"
      ? []
      : requiredStreams.filter((stream) => !(row?.successfulStreamKeys?.includes(stream) ?? false));
    const hasRequiredEvidence = source === "SCM"
      ? Boolean(row)
      : requiredStreams.length > 0 && missingStreams.length === 0;
    const state: ProductSourceEvidenceState = !row || !hasRequiredEvidence
      ? "missing"
      : row.state === "operational"
        ? "operational"
        : row.state === "observation"
          ? "observation"
          : "missing";
    return { source, state, missingStreams };
  });
  const operationalSources = sources.filter((row) => row.state === "operational").length;
  const observedSources = sources.filter((row) => row.state !== "missing").length;
  return {
    sources,
    observedSources,
    operationalSources,
    missingSources: sources.length - observedSources,
    missingStreams: sources.reduce((sum, row) => sum + row.missingStreams.length, 0),
  };
}
