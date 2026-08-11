import { describe, expect, it } from "vitest";

import { buildCommerceIdentityRepairExport } from "@/components/commerce-identity-export";
import type { CommerceIdentityCoverage } from "@/server/modules/report/commerce-identity-coverage";

describe("三平台身份修复导出", () => {
  it("把来源截止、问题、行动和只读门禁逐行随行", () => {
    const coverage = {
      state: "ready",
      authority: "observation_only",
      source: "JIANDAOYUN",
      gate: "完成对账与 UAT 前禁止放行",
      platforms: [
        { key: "tmall", sourceAsOf: "2026-08-11" },
      ],
      repairQueue: [
        {
          platformKey: "tmall",
          platform: "天猫",
          shopName: "旗舰店",
          externalId: "T2",
          productName: "面膜",
          bridgeLabel: "条码",
          bridgeValue: "6902",
          sourceRows: 1,
          issue: "unmapped_with_bridge",
          priority: 2,
          action: "按唯一条码进入人工认领",
          claimable: true,
        },
      ],
      summary: {},
      limitations: [],
    } as unknown as CommerceIdentityCoverage;

    const result = buildCommerceIdentityRepairExport(
      coverage,
      new Date("2026-08-12T04:00:00.000Z"),
    );

    expect(result.filename).toContain("简道云-三平台身份修复队列");
    expect(result.rows).toEqual([[
      "commerce_identity_repair",
      "observation_only",
      "JIANDAOYUN",
      "天猫",
      "2026-08-11",
      "2026-08-12T04:00:00.000Z",
      "P2",
      "有桥未映射",
      "旗舰店",
      "T2",
      "面膜",
      "条码",
      "6902",
      1,
      "是",
      "按唯一条码进入人工认领",
      "完成对账与 UAT 前禁止放行",
    ]]);
  });
});
