import type {
  JiandaoyunSupportingObservation,
  SupportingIdentityCoverage,
  SupportingObservationMetric,
} from "@/server/modules/report/jiandaoyun-supporting-observation";

export interface SupplyExternalEvidenceBrief {
  state: "available" | "missing";
  authority: "historical_observation";
  sourceAsOf: string | null;
  period: string;
  metrics: SupportingObservationMetric[];
  identities: Array<Pick<SupportingIdentityCoverage, "kind" | "label" | "governedMatches" | "distinctValues" | "openValues">>;
  quantityComparable: false;
  commitmentEligible: false;
}

/** 简道云采购需求池只做旧流程与控制量旁证，不得生成 PO 或改写供给承诺。 */
export function buildSupplyExternalEvidenceBrief(
  observations: readonly JiandaoyunSupportingObservation[],
): SupplyExternalEvidenceBrief {
  const observation = observations.find((item) => item.stream === "purchase-demand-observation");
  if (!observation) {
    return {
      state: "missing",
      authority: "historical_observation",
      sourceAsOf: null,
      period: "未取得",
      metrics: [],
      identities: [],
      quantityComparable: false,
      commitmentEligible: false,
    };
  }
  return {
    state: "available",
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
    quantityComparable: false,
    commitmentEligible: false,
  };
}
