import { describe, expect, it } from "vitest";

import { buildSupplyExternalEvidenceBrief } from "@/components/supply-external-evidence";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";

describe("供给承诺简道云采购需求旁证", () => {
  it("保留历史期与三类身份覆盖，但跨 SKU 数量不可直接比较，也不能改供给承诺", () => {
    const demand: JiandaoyunSupportingObservation = {
      stream: "purchase-demand-observation",
      authority: "historical_observation",
      runId: 200,
      importJobId: 431,
      sourceAsOf: "2024-12-11",
      businessDateFrom: "2023-03-20",
      businessDateThrough: "2024-12-10",
      rows: 60,
      metrics: [
        { key: "requested", label: "需求数量", value: "5142", unit: "" },
        { key: "purchased", label: "已采购数量", value: "3722", unit: "" },
      ],
      identityCoverage: [{
        kind: "sku_code", label: "SKU 身份", distinctValues: 6,
        governedMatches: 0, openValues: 6, queuedValues: 6, unqueuedValues: 0,
      }],
      summary: "需求数量 5,142",
      gate: "仅历史辅助",
    };

    expect(buildSupplyExternalEvidenceBrief([demand])).toMatchObject({
      state: "available",
      sourceAsOf: "2024-12-11",
      period: "2023-03-20 至 2024-12-10",
      quantityComparable: false,
      commitmentEligible: false,
      identities: [{
        kind: "sku_code", governedMatches: 0, distinctValues: 6, openValues: 6,
      }],
    });
  });

  it("缺批次时保持 missing，不伪装成零需求", () => {
    expect(buildSupplyExternalEvidenceBrief([])).toMatchObject({
      state: "missing",
      metrics: [],
      identities: [],
      quantityComparable: false,
      commitmentEligible: false,
    });
  });
});
