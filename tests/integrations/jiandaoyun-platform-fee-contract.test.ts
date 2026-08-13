import { describe, expect, it, vi } from "vitest";

import { auditJiandaoyunContracts } from "@/server/integrations/jiandaoyun-audit";
import {
  configuredJiandaoyunContracts,
  jiandaoyunContract,
  jiandaoyunContractProjection,
} from "@/server/integrations/jiandaoyun-contracts";

describe("简道云天猫费用观察契约", () => {
  it("保留冲销负数并排除未登记字段，不伪造 SKU 粒度", async () => {
    const contract = jiandaoyunContract("platform-fee-observation");
    expect(contract).not.toBeNull();
    expect(contract).toMatchObject({
      label: expect.stringContaining("仅天猫"),
      targetTable: "jdy_tmall_platform_fee_observation",
      freshnessMaxAgeDays: 7,
    });
    expect(contract!.businessKey).toBeUndefined();
    expect(contract!.fields.map((field) => field.target)).not.toContain("skuCode");

    const projection = jiandaoyunContractProjection(contract!);
    expect(projection).not.toContain("consumer_phone");
    expect(projection).not.toContain("buyer_message");
    const listRecords = vi.fn(async () => [{
      _id: "c".repeat(24),
      appId: contract!.appId,
      entryId: contract!.entryId,
      createTime: "2026-08-12T01:00:00.000Z",
      updateTime: "2026-08-12T02:00:00.000Z",
      deleteTime: null,
      statistical_date: { value: "2026-08-12" },
      shop_name: { value: "内部店铺" },
      fee_item: { value: "退费冲销" },
      billing_type: { value: "调整" },
      billing_currency: { value: "CNY" },
      billing_amount: { value: "-12.34" },
      paid_currency: { value: "CNY" },
      paid_amount: { value: "-12.34" },
      service_product: { value: "平台服务" },
      logistics_product: { value: "" },
      main_single_items_num: { value: "1" },
      deduction_type: { value: "" },
      expense_type: { value: "" },
      consumer_phone: { value: "13800000000" },
      buyer_message: { value: "sensitive" },
    }]);
    const client = {
      listWidgets: vi.fn(async () => contract!.fields.map((field) => ({
        name: field.source,
        label: field.target,
        type: contract!.numericControls?.some((item) => item.target === field.target)
          ? "number"
          : field.target === "statisticalDate" ? "datetime" : "text",
        items: [],
      }))),
      listRecords,
    };

    const [control] = await auditJiandaoyunContracts(client, {
      contracts: [contract!],
      now: new Date("2026-08-14T00:00:00.000Z"),
    });

    expect(listRecords).toHaveBeenCalledWith(contract!.appId, contract!.entryId, projection);
    expect(control).toMatchObject({
      sourceRows: 1,
      activeRows: 1,
      businessKey: null,
      freshness: { status: "current", currentUseBlocked: false },
      numericControls: [
        expect.objectContaining({ field: "billingAmount", invalid: 0, sum: "-12.34" }),
        expect.objectContaining({ field: "paidAmount", invalid: 0, sum: "-12.34" }),
        expect.objectContaining({ field: "mainLineCount", invalid: 0, sum: "1.0000" }),
      ],
    });
    expect(JSON.stringify(control)).not.toContain("13800000000");
    expect(JSON.stringify(control)).not.toContain("sensitive");
  });

  it("只有运维显式选择时才启用新费用流", () => {
    const baseEnv = { NODE_ENV: "test" } satisfies NodeJS.ProcessEnv;
    expect(configuredJiandaoyunContracts(baseEnv)).toEqual([]);
    expect(configuredJiandaoyunContracts({
      ...baseEnv,
      JIANDAOYUN_SYNC_CONTRACTS: "platform-fee-observation",
    }).map((contract) => contract.key)).toEqual([
      "platform-fee-observation",
    ]);
  });
});
