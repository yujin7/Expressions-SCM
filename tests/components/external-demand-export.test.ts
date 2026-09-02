import { describe, expect, it } from "vitest";

import {
  buildExternalDemandDailyExport,
  buildExternalDemandFulfillmentExport,
  buildExternalDemandIdentityExport,
  buildExternalDemandRefundDriversExport,
  buildExternalDemandRollingBriefExport,
  externalDemandIdentityAction,
  externalRefundDriverAction,
} from "@/components/external-demand-export";
import { serializeCsv } from "@/components/exportCsv";
import type { ExternalDemandSignal } from "@/server/modules/report/external-demand-signal";

const signal: ExternalDemandSignal = {
  state: "ready",
  authority: "observation_only",
  gate: "完成控制总量与 UAT 前禁止放行。",
  source: "JIANDAOYUN",
  platform: "天猫",
  sourceAsOf: "2026-08-11",
  crosswalkAsOf: "2026-08-10",
  daily: [
    {
      date: "2026-08-11",
      sourceRows: 12,
      validPaidRows: 11,
      invalidSalesRows: 1,
      invalidRefundRows: 2,
      paidQty: 120,
      refundQty: 5,
      netQty: 115,
      mappedPaidQty: 95,
      mappedRefundQty: 5,
      mappedNetQty: 90,
    },
  ],
  decisionBrief: {
    state: "insufficient",
    gate: "两个窗口尚不完整。",
    anchorDate: "2026-08-11",
    current: {
      startDate: "2026-08-05", endDate: "2026-08-11", observedDays: 1, requiredDays: 7,
      paidQty: 120, refundQty: 5, netQty: 115,
      mappedPaidQty: 95, mappedRefundQty: 5, mappedNetQty: 90,
      refundRatePct: 4.2, mappedPaidCoveragePct: 79.2,
    },
    previous: {
      startDate: "2026-07-29", endDate: "2026-08-04", observedDays: 0, requiredDays: 7,
      paidQty: 0, refundQty: 0, netQty: 0,
      mappedPaidQty: 0, mappedRefundQty: 0, mappedNetQty: 0,
      refundRatePct: null, mappedPaidCoveragePct: null,
    },
    change: {
      paidQtyPct: null, netQtyPct: null,
      refundRateDeltaPp: null, mappedPaidCoverageDeltaPp: null,
    },
    movement: { netDemand: "unknown", refundRate: "unknown", mappedPaidCoverage: "unknown" },
  },
  refundDrivers: {
    state: "insufficient",
    authority: "observation_only",
    grain: "店铺 × 天猫平台 SKU × 双自然日窗口",
    gate: "双窗口未开放。",
    movement: "unknown",
    totals: {
      currentRefundQty: 5,
      previousRefundQty: 0,
      deltaRefundQty: null,
      changePct: null,
      movementPoolQty: null,
    },
    eligibleDrivers: 0,
    identityCoverage: {
      mappedDrivers: 0, unmappedDrivers: 0,
      mappedMovementPoolQty: 0, mappedMovementPoolPct: null,
    },
    byShop: [],
    topContributors: [],
  },
  totals: {
    paidQty: 120, refundQty: 5, netQty: 115,
    mappedPaidQty: 95, mappedRefundQty: 5, mappedNetQty: 90,
  },
  coverage: {
    salesRows: 12, mappedSalesRows: 10, rowPct: 83.3,
    platformIdentities: 8, mappedIdentities: 6, identityPct: 75, paidQtyPct: 79.2,
  },
  quality: { invalidSalesRows: 1, invalidRefundRows: 2, conflictingCrosswalks: 3 },
  fulfillment: {
    state: "ready",
    authority: "comparison_only",
    jstSourceAsOf: "2026-08-11",
    grain: "业务日 × SCM SKU（跨店铺、跨仓汇总）",
    gate: "仅用于 UAT 核对。",
    totals: {
      jdyMappedNetQty: 90, jstMappedOutboundQty: 88,
      comparableDemandQty: 90, comparableOutboundQty: 88,
      gapQty: -2, absoluteGapQty: 2,
    },
    coverage: {
      jdyMappedSkuDays: 2, jstMappedSkuDays: 2, comparableSkuDays: 1,
      jdyComparablePct: 50, jstComparablePct: 50,
    },
    daily: [{
      date: "2026-08-11", mappedNetDemandQty: 90, jstOutboundQty: 88,
      comparableDemandQty: 90, comparableOutboundQty: 88, gapQty: -2,
      onlyJdySkuDays: 1, onlyJstSkuDays: 1,
    }],
    topGaps: [{
      date: "2026-08-11", skuId: 101, skuCode: "E001-001",
      mappedNetDemandQty: 90, jstOutboundQty: 88, gapQty: -2, absoluteGapQty: 2,
    }],
  },
  topUnmapped: [
    {
      shopName: "EXP 天猫店", platformSkuId: "=HYPERLINK(\"bad\")", barcode: null,
      exceptionId: null, exceptionStatus: null, productName: "+外部商品", skuName: "规格A",
      paidQty: 25, refundQty: 2, netQty: 23,
    },
    {
      shopName: "NING 天猫店", platformSkuId: "SKU-2", barcode: "6970002",
      exceptionId: 42, exceptionStatus: "open", productName: "商品B", skuName: null,
      paidQty: 18, refundQty: 1, netQty: 17,
    },
  ],
  limitations: ["观察口径"],
};

describe("简道云外部需求 UAT 导出", () => {
  const now = new Date("2026-08-12T03:04:05.000Z");

  it("日核对逐行携带来源截止、覆盖、质量和放行口径", () => {
    const result = buildExternalDemandDailyExport(signal, now);
    expect(result.filename).toContain("2026-08-11");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(expect.arrayContaining([
      "daily_control_total", "observation_only", "2026-08-11", "2026-08-10",
      "75.0", "79.2", 6, "完成控制总量与 UAT 前禁止放行。",
    ]));
  });

  it("身份队列携带异常回查键和确定性下一步动作", () => {
    const result = buildExternalDemandIdentityExport(signal, now);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toContain("回源补对照/条码");
    expect(result.rows[1]).toEqual(expect.arrayContaining([42, "open", "去认领"]));
    expect(externalDemandIdentityAction({ ...signal.topUnmapped[1], exceptionStatus: "resolved" }))
      .toBe("已认领·待同步");
  });

  it("滚动简报导出保留两个窗口的日覆盖与关闭原因", () => {
    const result = buildExternalDemandRollingBriefExport(signal, now);
    expect(result.filename).toContain("2026-08-11");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual(expect.arrayContaining([
      "rolling_demand_brief", "observation_only", "insufficient", "两个窗口尚不完整。",
      "current_7d", "2026-08-05", "2026-08-11", 1, 7, 120, 5, 115,
    ]));
    expect(result.rows[1]).toEqual(expect.arrayContaining([
      "previous_7d", "2026-07-29", "2026-08-04", 0, 7,
    ]));
  });

  it("退款驱动导出保留同向贡献池、身份动作和双窗口数值", () => {
    const withDrivers: ExternalDemandSignal = {
      ...signal,
      refundDrivers: {
        state: "ready",
        authority: "observation_only",
        grain: "店铺 × 天猫平台 SKU × 双自然日窗口",
        gate: "只呈现同方向变化贡献。",
        movement: "up",
        totals: {
          currentRefundQty: 42,
          previousRefundQty: 21,
          deltaRefundQty: 21,
          changePct: 100,
          movementPoolQty: 21,
        },
        eligibleDrivers: 1,
        identityCoverage: {
          mappedDrivers: 0,
          unmappedDrivers: 1,
          mappedMovementPoolQty: 0,
          mappedMovementPoolPct: 0,
        },
        byShop: [{
          shopName: "EXP 天猫店",
          currentRefundQty: 42,
          previousRefundQty: 21,
          netDeltaRefundQty: 21,
          movementPoolQty: 21,
          movementPoolSharePct: 100,
          eligibleDrivers: 1,
          unmappedDrivers: 1,
        }],
        topContributors: [{
          shopName: "EXP 天猫店",
          platformSkuId: "P1",
          barcode: "6901",
          skuId: null,
          exceptionId: 42,
          exceptionStatus: "open",
          productName: "商品A",
          skuName: "规格A",
          currentPaidQty: 70,
          currentRefundQty: 21,
          currentRefundRatePct: 30,
          previousPaidQty: 70,
          previousRefundQty: 7,
          previousRefundRatePct: 10,
          deltaRefundQty: 14,
          refundRateDeltaPp: 20,
          movementPoolSharePct: 66.7,
        }],
      },
    };
    const result = buildExternalDemandRefundDriversExport(withDrivers, now);
    expect(result.filename).toContain("2026-08-11");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(expect.arrayContaining([
      "refund_change_driver", "observation_only", "up", 42, 21, 21, "100.0",
      "EXP 天猫店", "P1", "6901", 70, 21, "30.0", 70, 7, "10.0",
      14, "20.0", "66.7", "去认领", "只呈现同方向变化贡献。",
    ]));
    expect(externalRefundDriverAction(withDrivers.refundDrivers.topContributors[0])).toBe("去认领");
  });

  it("导出层把外部公式样式字段强制作为文本，同时保留负数", () => {
    const exportData = buildExternalDemandIdentityExport(signal, now);
    const csv = serializeCsv(exportData.headers, exportData.rows);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+外部商品");
    expect(serializeCsv(["值"], [[-2], ["-0.5000"]])).toContain("-2\r\n-0.5000");
  });

  it("跨源履约导出只携带可比样本、两边截止和覆盖率", () => {
    const result = buildExternalDemandFulfillmentExport(signal, now);
    expect(result.filename).toContain("2026-08-11");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(expect.arrayContaining([
      "demand_fulfillment_comparison", "comparison_only", "E001-001",
      90, 88, -2, 2, "50.0", "仅用于 UAT 核对。",
    ]));
  });
});
