import type {
  JiandaoyunSupportingObservation,
  SupportingIdentityCoverage,
  SupportingObservationMetric,
} from "@/server/modules/report/jiandaoyun-supporting-observation";

const TARGETS = [
  { stream: "product-master-observation", label: "产品主档快照" },
  { stream: "sample-management-observation", label: "样品收货与检验历史" },
] as const;

export interface LaunchExternalEvidenceBrief {
  stream: typeof TARGETS[number]["stream"];
  label: string;
  state: "available" | "missing";
  authority: "historical_observation";
  sourceAsOf: string | null;
  period: string;
  metrics: SupportingObservationMetric[];
  identities: Array<Pick<SupportingIdentityCoverage, "kind" | "label" | "governedMatches" | "distinctValues" | "openValues">>;
  launchDecisionEligible: false;
}

/**
 * 简道云产品主档与样品旧表只能补充新品项目背景，不能替代正式里程碑、首单到货或首销事实。
 */
export function buildLaunchExternalEvidenceBriefs(
  observations: readonly JiandaoyunSupportingObservation[],
): LaunchExternalEvidenceBrief[] {
  const byStream = new Map(observations.map((observation) => [observation.stream, observation]));
  return TARGETS.map((target) => {
    const observation = byStream.get(target.stream);
    if (!observation) {
      return {
        ...target,
        state: "missing" as const,
        authority: "historical_observation" as const,
        sourceAsOf: null,
        period: "未取得",
        metrics: [],
        identities: [],
        launchDecisionEligible: false as const,
      };
    }
    return {
      ...target,
      state: "available" as const,
      authority: observation.authority,
      sourceAsOf: observation.sourceAsOf,
      period: observation.businessDateFrom && observation.businessDateThrough
        ? `${observation.businessDateFrom} 至 ${observation.businessDateThrough}`
        : observation.sourceAsOf ?? "源表未提供业务日期",
      metrics: observation.metrics,
      identities: observation.identityCoverage.map((identity) => ({
        kind: identity.kind,
        label: identity.label,
        governedMatches: identity.governedMatches,
        distinctValues: identity.distinctValues,
        openValues: identity.openValues,
      })),
      launchDecisionEligible: false as const,
    };
  });
}
