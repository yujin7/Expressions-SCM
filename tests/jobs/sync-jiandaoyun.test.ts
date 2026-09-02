import { describe, expect, it } from "vitest";

import { shouldRefreshJiandaoyunDemandModels } from "@/jobs/sync-jiandaoyun";

describe("简道云配置同步读模型刷新", () => {
  it("任一相关契约成功即可刷新，不要求部署同时选择所有外部数据流", () => {
    expect(shouldRefreshJiandaoyunDemandModels([
      "tmall-sku-crosswalk-observation",
      "tmall-sku-sales-observation",
      "tmall-sku-refund-observation",
    ])).toBe(true);
    expect(shouldRefreshJiandaoyunDemandModels(["pdd-order-observation"])).toBe(true);
    expect(shouldRefreshJiandaoyunDemandModels(["product-master-observation"])).toBe(false);
  });
});
