import { describe, expect, it } from "vitest";

import { buildPlatformFeeUatExport } from "@/components/platform-fee-export";
import { serializeCsv } from "@/components/exportCsv";
import type { JiandaoyunPlatformFeeObservation } from "@/server/modules/report/platform-fee-observation";

describe("天猫平台费用财务 UAT 导出", () => {
  it("逐层携带门禁证据并防止外部费用项公式注入", () => {
    const signal: JiandaoyunPlatformFeeObservation = {
      state: "preview",
      authority: "observation_only",
      source: "JIANDAOYUN",
      platform: "天猫",
      sourceAsOf: "2026-08-12",
      businessDateFrom: "2026-08-01",
      businessDateThrough: "2026-08-02",
      selectedForSync: false,
      importJobId: 397,
      runId: 166,
      gate: "仅财务 UAT",
      totals: { sourceRows: 2, stagedRows: 2, validRows: 2, invalidRows: 0 },
      quality: {
        invalidDateRows: 0,
        invalidBillingAmountRows: 0,
        invalidPaidAmountRows: 0,
        missingShopRows: 0,
        missingFeeItemRows: 0,
        missingCurrencyRows: 0,
        currencyMismatchRows: 0,
      },
      currencies: [{ currency: "CNY", rows: 2, billingAmount: "90.00", paidAmount: "82.00", billingPaidDelta: "-8.00", positivePaidAmount: "90.00", reversalPaidAmount: "-8.00", negativeRows: 1 }],
      monthly: [{ key: "2026-08", currency: "CNY", rows: 2, billingAmount: "90.00", paidAmount: "82.00", billingPaidDelta: "-8.00", positivePaidAmount: "90.00", reversalPaidAmount: "-8.00", negativeRows: 1 }],
      shops: [{ key: "旗舰店", currency: "CNY", rows: 2, billingAmount: "90.00", paidAmount: "82.00", billingPaidDelta: "-8.00", positivePaidAmount: "90.00", reversalPaidAmount: "-8.00", negativeRows: 1 }],
      feeItems: [{ key: "=HYPERLINK(\"bad\")", currency: "CNY", rows: 2, billingAmount: "90.00", paidAmount: "82.00", billingPaidDelta: "-8.00", positivePaidAmount: "90.00", reversalPaidAmount: "-8.00", negativeRows: 1 }],
      limitations: [],
    };

    const output = buildPlatformFeeUatExport(signal, new Date("2026-08-14T00:00:00.000Z"));
    expect(output.rows).toHaveLength(4);
    expect(output.rows[0]).toEqual(expect.arrayContaining(["currency_control", "否", 166, 397, "仅财务 UAT"]));
    expect(output.filename).toContain("2026-08-02");
    const csv = serializeCsv(output.headers, output.rows);
    expect(csv).toContain("业务统计起始,业务统计截止,批次源更新时间");
    expect(csv).toContain("2026-08-01,2026-08-02,2026-08-12");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("-8.00");
  });
});
