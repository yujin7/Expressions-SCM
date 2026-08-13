import { describe, expect, it } from "vitest";

import {
  buildExternalDemandDailyExport,
  buildExternalDemandFulfillmentExport,
  buildExternalDemandIdentityExport,
  externalDemandIdentityAction,
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
    { date: "2026-08-11", paidQty: 120, refundQty: 5, netQty: 115, mappedNetQty: 90 },
  ],
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
