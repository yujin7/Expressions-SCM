import { describe, expect, it } from "vitest";

import { evaluateProductSourceEvidence } from "@/components/data-product-source-evidence";
import type { DataProductDefinition } from "@/components/data-products";
import type { DataSourceReadiness } from "@/server/modules/report/data-source-readiness";

function source(
  key: DataSourceReadiness["key"],
  state: DataSourceReadiness["state"],
  successfulStreamKeys: string[],
): DataSourceReadiness {
  return {
    key,
    label: key,
    state,
    configured: true,
    enabled: true,
    contractSelectionState: "selected",
    selectedContractCount: 1,
    successfulStreams: successfulStreamKeys.length,
    successfulStreamKeys,
    latestFailedStreams: 0,
    latestRunningStreams: 0,
    sourceRows: 1,
    stagedRows: 1,
    rejectedRows: 0,
    latestRunAt: null,
    lastSuccessAt: null,
    sourceAsOfStart: null,
    sourceAsOfEnd: null,
    openIdentityExceptions: 0,
    observedIdentities: 1,
    gate: "gate",
    nextAction: "next",
  };
}

const product: DataProductDefinition = {
  id: "demand-pulse-test",
  title: "需求脉搏测试",
  decision: "test",
  grain: "day x sku",
  owner: "test",
  sources: ["SCM", "JST"],
  requiredStreams: { JST: ["outbound-sales-daily"] },
  targetAuthority: "operational",
  releaseGate: "test",
};

describe("数据产品所需流证据", () => {
  it("不用同连接器的无关成功流代替产品所需流", () => {
    const result = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      source("JST", "observation", ["inventory-total-delta"]),
    ]);

    expect(result).toMatchObject({
      observedSources: 1,
      operationalSources: 1,
      missingSources: 1,
      missingStreams: 1,
    });
    expect(result.sources[1]).toMatchObject({
      source: "JST",
      state: "missing",
      missingStreams: ["outbound-sales-daily"],
    });
  });

  it("只在所需流成功且连接器通过状态门时计入观察或放行", () => {
    const observed = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      source("JST", "observation", ["outbound-sales-daily"]),
    ]);
    expect(observed).toMatchObject({ observedSources: 2, operationalSources: 1, missingStreams: 0 });

    const operational = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      source("JST", "operational", ["outbound-sales-daily"]),
    ]);
    expect(operational).toMatchObject({ observedSources: 2, operationalSources: 2, missingStreams: 0 });
  });

  it("旧标签页缓存没有流列表时安全降级，不崩页也不误放行", () => {
    const legacyJst = source("JST", "observation", []);
    delete (legacyJst as Partial<DataSourceReadiness>).successfulStreamKeys;
    const result = evaluateProductSourceEvidence(product, [
      source("SCM", "operational", []),
      legacyJst,
    ]);

    expect(result).toMatchObject({ observedSources: 1, missingSources: 1, missingStreams: 1 });
  });
});
