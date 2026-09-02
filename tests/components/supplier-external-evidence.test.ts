import { describe, expect, it } from "vitest";

import { buildSupplierExternalEvidenceBriefs } from "@/components/supplier-external-evidence";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";

describe("供应商 360 简道云外部佐证", () => {
  it("历史身份即使有部分认领也不进入评分；缺少样品流保持 missing", () => {
    const supplier: JiandaoyunSupportingObservation = {
      stream: "supplier-observation",
      authority: "historical_observation",
      runId: 203,
      importJobId: 434,
      sourceAsOf: "2024-06-25",
      businessDateFrom: null,
      businessDateThrough: null,
      rows: 4,
      metrics: [{ key: "rows", label: "供应商记录", value: "4", unit: "家" }],
      identityCoverage: [{
        kind: "supplier", label: "供应商身份", distinctValues: 4,
        governedMatches: 1, openValues: 3, queuedValues: 3, unqueuedValues: 0,
      }],
      summary: "供应商记录 4家",
      gate: "仅历史辅助",
    };

    const result = buildSupplierExternalEvidenceBriefs([supplier]);
    expect(result).toEqual([
      expect.objectContaining({
        stream: "supplier-observation",
        state: "available",
        period: "2024-06-25",
        scoreEligible: false,
        supplierIdentity: { governedMatches: 1, distinctValues: 4, openValues: 3 },
      }),
      expect.objectContaining({
        stream: "sample-management-observation",
        state: "missing",
        scoreEligible: false,
        metrics: [],
      }),
    ]);
  });

  it("样品历史保留业务日期和原聚合指标，不把一条不符合直接定性为当前供应商风险", () => {
    const sample: JiandaoyunSupportingObservation = {
      stream: "sample-management-observation",
      authority: "historical_observation",
      runId: 207,
      importJobId: 438,
      sourceAsOf: "2024-06-25",
      businessDateFrom: "2023-09-01",
      businessDateThrough: "2024-06-25",
      rows: 5,
      metrics: [
        { key: "rows", label: "样品批次", value: "5", unit: "批" },
        { key: "nonconforming", label: "检验不符合", value: "1", unit: "批" },
      ],
      identityCoverage: [],
      summary: "样品批次 5批 · 检验不符合 1批",
      gate: "仅历史辅助",
    };

    const result = buildSupplierExternalEvidenceBriefs([sample])[1];
    expect(result).toMatchObject({
      state: "available",
      period: "2023-09-01 至 2024-06-25",
      metrics: sample.metrics,
      scoreEligible: false,
    });
  });
});
