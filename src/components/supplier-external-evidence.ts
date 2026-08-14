import type {
  JiandaoyunSupportingObservation,
  SupportingObservationMetric,
} from "@/server/modules/report/jiandaoyun-supporting-observation";

const TARGETS = [
  { stream: "supplier-observation", label: "供应商主档快照" },
  { stream: "sample-management-observation", label: "样品管理历史" },
] as const;

export interface SupplierExternalEvidenceBrief {
  stream: typeof TARGETS[number]["stream"];
  label: string;
  state: "available" | "missing";
  authority: "historical_observation";
  sourceAsOf: string | null;
  period: string;
  metrics: SupportingObservationMetric[];
  supplierIdentity: {
    governedMatches: number;
    distinctValues: number;
    openValues: number;
  } | null;
  gate: string;
  scoreEligible: false;
}

/**
 * 把简道云供应商/样品辅助流转成供应商 360 可展示的安全摘要。
 * 缺流保持 missing；历史数据即使身份全认领也永不直接进入当期评分。
 */
export function buildSupplierExternalEvidenceBriefs(
  observations: readonly JiandaoyunSupportingObservation[],
): SupplierExternalEvidenceBrief[] {
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
        supplierIdentity: null,
        gate: "尚无最新成功批次；缺失不能解释为 0，也不进入供应商评分。",
        scoreEligible: false as const,
      };
    }
    const identity = observation.identityCoverage.find((item) => item.kind === "supplier");
    return {
      ...target,
      state: "available" as const,
      authority: observation.authority,
      sourceAsOf: observation.sourceAsOf,
      period: observation.businessDateFrom && observation.businessDateThrough
        ? `${observation.businessDateFrom} 至 ${observation.businessDateThrough}`
        : observation.sourceAsOf ?? "源表未提供业务日期",
      metrics: observation.metrics,
      supplierIdentity: identity ? {
        governedMatches: identity.governedMatches,
        distinctValues: identity.distinctValues,
        openValues: identity.openValues,
      } : null,
      gate: observation.gate,
      scoreEligible: false as const,
    };
  });
}
