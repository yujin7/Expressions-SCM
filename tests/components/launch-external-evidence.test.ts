import { describe, expect, it } from "vitest";

import { buildLaunchExternalEvidenceBriefs } from "@/components/launch-external-evidence";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";

describe("新品项目简道云外部佐证", () => {
  it("产品主档即使字段完整也不等于新品已就绪", () => {
    const product: JiandaoyunSupportingObservation = {
      stream: "product-master-observation",
      authority: "historical_observation",
      runId: 199,
      importJobId: 430,
      sourceAsOf: "2024-07-29",
      businessDateFrom: null,
      businessDateThrough: null,
      rows: 8,
      metrics: [
        { key: "rows", label: "产品记录", value: "8", unit: "条" },
        { key: "coded", label: "编码完整", value: "8", unit: "条" },
      ],
      identityCoverage: [{
        kind: "sku_code", label: "SKU 身份", distinctValues: 8,
        governedMatches: 0, openValues: 8, queuedValues: 8, unqueuedValues: 0,
      }],
      summary: "产品记录 8条",
      gate: "仅历史辅助",
    };

    expect(buildLaunchExternalEvidenceBriefs([product])[0]).toMatchObject({
      state: "available",
      period: "2024-07-29",
      launchDecisionEligible: false,
      identities: [{
        kind: "sku_code", label: "SKU 身份", governedMatches: 0, distinctValues: 8, openValues: 8,
      }],
    });
  });

  it("样品流缺失时保持未知，不显示成零风险", () => {
    expect(buildLaunchExternalEvidenceBriefs([])[1]).toMatchObject({
      stream: "sample-management-observation",
      state: "missing",
      metrics: [],
      identities: [],
      launchDecisionEligible: false,
    });
  });
});
