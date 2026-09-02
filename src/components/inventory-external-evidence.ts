import type {
  JiandaoyunSupportingObservation,
  SupportingObservationMetric,
} from "@/server/modules/report/jiandaoyun-supporting-observation";

const TARGETS = [
  { stream: "warehouse-observation", label: "仓库资料快照" },
  { stream: "inventory-count-observation", label: "盘点差异历史" },
  { stream: "warehouse-transfer-observation", label: "调拨执行历史" },
] as const;

export interface InventoryExternalEvidenceBrief {
  stream: typeof TARGETS[number]["stream"];
  label: string;
  state: "available" | "missing";
  authority: "historical_observation";
  sourceAsOf: string | null;
  period: string;
  dateAnomaly: string | null;
  metrics: SupportingObservationMetric[];
  warehouseIdentity: {
    governedMatches: number;
    distinctValues: number;
    openValues: number;
  } | null;
  gate: string;
  reconciliationEligible: false;
}

/**
 * 把简道云仓库、盘点和调拨旧表转成库存页可展示的安全摘要。
 * 它们永远只是历史佐证，不能调平当前库存、补零或通过库存放行门。
 */
export function buildInventoryExternalEvidenceBriefs(
  observations: readonly JiandaoyunSupportingObservation[],
): InventoryExternalEvidenceBrief[] {
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
        dateAnomaly: null,
        metrics: [],
        warehouseIdentity: null,
        gate: "尚无最新成功批次；缺失不能解释为 0，也不能用于账实调平。",
        reconciliationEligible: false as const,
      };
    }
    const identity = observation.identityCoverage.find((item) => item.kind === "warehouse");
    return {
      ...target,
      state: "available" as const,
      authority: observation.authority,
      sourceAsOf: observation.sourceAsOf,
      period: observation.businessDateFrom && observation.businessDateThrough
        ? `${observation.businessDateFrom} 至 ${observation.businessDateThrough}`
        : observation.sourceAsOf ?? "源表未提供业务日期",
      dateAnomaly: observation.sourceAsOf
        && observation.businessDateThrough
        && observation.businessDateThrough > observation.sourceAsOf
        ? `业务截止 ${observation.businessDateThrough} 晚于源截止 ${observation.sourceAsOf}，可能是计划日期，需回源确认。`
        : null,
      metrics: observation.metrics,
      warehouseIdentity: identity ? {
        governedMatches: identity.governedMatches,
        distinctValues: identity.distinctValues,
        openValues: identity.openValues,
      } : null,
      gate: observation.gate,
      reconciliationEligible: false as const,
    };
  });
}
