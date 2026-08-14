import { describe, expect, it } from "vitest";

import { serializeCsv } from "@/components/exportCsv";
import { buildTmallChannelContributionExport } from "@/components/tmall-channel-contribution-export";
import type { TmallChannelContributionObservation } from "@/server/modules/report/tmall-channel-contribution";

describe("天猫渠道金额贡献桥导出", () => {
  it("同时导出月份控制与缺失来源店铺，并防公式注入", () => {
    const signal: TmallChannelContributionObservation = {
      state: "preview",
      authority: "observation_only",
      source: "JIANDAOYUN",
      platform: "天猫",
      grain: "完整自然月 × 店铺 × 源表原币",
      latestClosedMonth: "2026-07",
      commonBusinessDateFrom: "2026-05-01",
      commonBusinessDateThrough: "2026-08-12",
      sources: { sales: null, refunds: null, fees: null },
      coverage: {
        closedShopMonths: 2, comparableShopMonths: 1,
        missingSalesShopMonths: 1, missingRefundShopMonths: 1, missingFeeShopMonths: 0,
        latestMonthComparableShops: 1, latestMonthTotalShops: 2,
      },
      monthly: [{
        month: "2026-07", currency: "CNY", comparableShops: 1, totalShops: 2,
        grossPaidAmount: "1000.00", successfulRefundAmount: "100.00",
        netCollectedObservation: "900.00", platformFeePaidAmount: "200.00",
        contributionBeforeProductCost: "700.00", refundAmountRatePct: "10.00",
        platformFeeRatePct: "22.22", excludedFeePaidAmount: "50.00",
      }],
      latestShops: [
        {
          month: "2026-07", shopName: "正常店", currency: "CNY", comparable: true,
          salesRows: 1, refundRows: 1, feeRows: 1, grossPaidAmount: "1000.00",
          successfulRefundAmount: "100.00", netCollectedObservation: "900.00",
          platformFeePaidAmount: "200.00", contributionBeforeProductCost: "700.00",
          refundAmountRatePct: "10.00", platformFeeRatePct: "22.22", missingSources: [],
        },
        {
          month: "2026-07", shopName: "=HYPERLINK(\"bad\")", currency: "CNY", comparable: false,
          salesRows: 0, refundRows: 0, feeRows: 1, grossPaidAmount: null,
          successfulRefundAmount: null, netCollectedObservation: null,
          platformFeePaidAmount: "50.00", contributionBeforeProductCost: null,
          refundAmountRatePct: null, platformFeeRatePct: null, missingSources: ["sales", "refunds"],
        },
      ],
      gate: "仅财务 UAT",
      limitations: [],
    };

    const output = buildTmallChannelContributionExport(signal, new Date("2026-08-14T00:00:00.000Z"));
    expect(output.rows).toHaveLength(3);
    expect(output.filename).toContain("2026-07");
    const csv = serializeCsv(output.headers, output.rows);
    expect(csv).toContain("支付金额,成功退款金额,净回款观察,平台费用支付金额,产品成本前渠道贡献");
    expect(csv).toContain("700.00");
    expect(csv).toContain("sales/refunds");
    expect(csv).toContain("'=HYPERLINK");
  });
});
