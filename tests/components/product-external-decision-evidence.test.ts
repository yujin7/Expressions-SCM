import { describe, expect, it } from "vitest";

import { buildProductExternalDecisionEvidenceBrief } from "@/components/product-external-decision-evidence";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";

function source(key: DataSourceReadiness["key"], partial: Partial<DataSourceReadiness> = {}): DataSourceReadiness {
  return {
    key,
    label: key,
    state: key === "SCM" ? "operational" : "blocked",
    configured: key === "SCM",
    enabled: key === "SCM",
    configurationReady: key === "SCM",
    configurationBinding: `${key}-binding`,
    contractSelectionState: key === "SCM" ? "not_required" : "missing",
    selectedContractCount: 0,
    successfulStreams: 0,
    successfulStreamKeys: [],
    streams: [],
    latestFailedStreams: 0,
    latestRunningStreams: 0,
    sourceRows: 0,
    stagedRows: 0,
    rejectedRows: 0,
    latestRunAt: null,
    lastSuccessAt: null,
    sourceAsOfStart: null,
    sourceAsOfEnd: null,
    openIdentityExceptions: 0,
    observedIdentities: 0,
    identityCoverage: [],
    scmEvidence: {},
    gate: "测试",
    nextAction: "测试",
    ...partial,
  };
}

describe("业务页面跨系统决策证据摘要", () => {
  it("供给承诺只返回安全状态与控制量，不把缺失流当成零", () => {
    const brief = buildProductExternalDecisionEvidenceBrief("supply-commitment", [
      source("SCM"),
      source("JIANDAOYUN", {
        availableStreamKeys: ["purchase-order-observation", "purchase-receipt-observation"],
        configurationBinding: "JIANDAOYUN_SECRET_BINDING",
      }),
      source("JST", { availableStreamKeys: ["inbound-receipts-daily"] }),
      source("YONYOU", { availableStreamKeys: ["yonbip-scm-purchaseorder-list", "yonbip-scm-purinrecord-list"] }),
    ]);

    expect(brief.inputLevel).toBe("A0");
    expect(brief.sources.map((item) => item.source)).toEqual(["JIANDAOYUN", "JST", "YONYOU"]);
    expect(brief.sources.flatMap((item) => item.streams)).toHaveLength(5);
    expect(brief.sources.flatMap((item) => item.streams).every((item) => item.sourceRows === null)).toBe(true);
    expect(brief.blockerSummary).toContain("保持未知");
    expect(JSON.stringify(brief)).not.toContain("configurationBinding");
    expect(JSON.stringify(brief)).not.toContain("JIANDAOYUN_SECRET_BINDING");
  });

  it("不存在的数据产品会拒绝，而不是返回空白成功", () => {
    expect(() => buildProductExternalDecisionEvidenceBrief("unknown-product", [])).toThrow("未知数据产品");
  });
});
