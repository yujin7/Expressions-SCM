import { describe, expect, it } from "vitest";
import { selectJiandaoyunAuditContracts } from "@/jobs/audit-jiandaoyun";
import { JIANDAOYUN_FORM_CONTRACTS } from "@/server/integrations/jiandaoyun-contracts";

describe("简道云定向契约审计", () => {
  it("无筛选时保留全量审计", () => {
    expect(selectJiandaoyunAuditContracts()).toEqual(JIANDAOYUN_FORM_CONTRACTS);
  });

  it("按请求顺序去重并只审计指定契约", () => {
    expect(selectJiandaoyunAuditContracts([
      "tmall-sku-sales-observation",
      "tmall-sku-refund-observation",
      "tmall-sku-sales-observation",
    ]).map((contract) => contract.key)).toEqual([
      "tmall-sku-sales-observation",
      "tmall-sku-refund-observation",
    ]);
  });

  it("未知契约失败关闭，避免误以为已覆盖", () => {
    expect(() => selectJiandaoyunAuditContracts(["not-a-contract"]))
      .toThrow("未知简道云契约: not-a-contract");
  });
});
