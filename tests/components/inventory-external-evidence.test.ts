import { describe, expect, it } from "vitest";

import { buildInventoryExternalEvidenceBriefs } from "@/components/inventory-external-evidence";
import type { JiandaoyunSupportingObservation } from "@/server/modules/report/jiandaoyun-supporting-observation";

describe("库存分析简道云外部佐证", () => {
  it("盘点历史保留期间与仓库认领覆盖，但永不用于当前账实调平", () => {
    const count: JiandaoyunSupportingObservation = {
      stream: "inventory-count-observation",
      authority: "historical_observation",
      runId: 206,
      importJobId: 437,
      sourceAsOf: "2024-07-22",
      businessDateFrom: "2022-12-31",
      businessDateThrough: "2024-07-26",
      rows: 5,
      metrics: [
        { key: "rows", label: "盘点单", value: "5", unit: "单" },
        { key: "loss", label: "盘亏数量", value: "43", unit: "" },
      ],
      identityCoverage: [{
        kind: "warehouse", label: "仓库身份", distinctValues: 2,
        governedMatches: 0, openValues: 2, queuedValues: 2, unqueuedValues: 0,
      }],
      summary: "盘点单 5单 · 盘亏数量 43",
      gate: "仅历史辅助",
    };

    const result = buildInventoryExternalEvidenceBriefs([count]);
    expect(result[1]).toMatchObject({
      stream: "inventory-count-observation",
      state: "available",
      period: "2022-12-31 至 2024-07-26",
      dateAnomaly: "业务截止 2024-07-26 晚于源截止 2024-07-22，可能是计划日期，需回源确认。",
      warehouseIdentity: { governedMatches: 0, distinctValues: 2, openValues: 2 },
      reconciliationEligible: false,
    });
  });

  it("缺少仓库或调拨批次时保持 missing，不用零值伪装", () => {
    const result = buildInventoryExternalEvidenceBriefs([]);
    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stream: "warehouse-observation",
        state: "missing",
        metrics: [],
        dateAnomaly: null,
        reconciliationEligible: false,
      }),
      expect.objectContaining({
        stream: "warehouse-transfer-observation",
        state: "missing",
        metrics: [],
        reconciliationEligible: false,
      }),
    ]));
  });
});
