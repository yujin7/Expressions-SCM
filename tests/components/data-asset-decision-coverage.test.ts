import { describe, expect, it } from "vitest";

import { buildDataAssetDecisionPortfolio } from "@/components/data-asset-decision-coverage";
import { DATA_PRODUCTS, type DataProductDefinition } from "@/components/data-products";
import type { DataSourceReadiness, DataStreamEvidence } from "@/server/modules/report/data-source-readiness";
import type { DataProductReleaseReadiness } from "@/server/modules/report/data-product-release";

function stream(key: string, overrides: Partial<DataStreamEvidence> = {}): DataStreamEvidence {
  return {
    stream: key,
    latestStatus: "succeeded",
    latestRunAt: "2026-08-13T01:00:00.000Z",
    lastSuccessAt: "2026-08-13T01:00:00.000Z",
    sourceAsOf: "2026-08-13",
    sourceRows: 10,
    stagedRows: 10,
    rejectedRows: 0,
    authorizationBlocked: false,
    sourceTimeInvalid: false,
    releaseBlocked: false,
    schemaDrift: false,
    emptySource: false,
    freshnessMaxAgeDays: 2,
    businessAgeDays: 0,
    pipelineAgeHours: 2,
    freshness: "current",
    ...overrides,
  };
}

function source(
  key: DataSourceReadiness["key"],
  streams: DataStreamEvidence[],
  stateOverride?: DataSourceReadiness["state"],
): DataSourceReadiness {
  return {
    key,
    label: key,
    state: stateOverride ?? (key === "SCM" ? "operational" : streams.length > 0 ? "observation" : "contract_only"),
    configured: key === "SCM" || streams.length > 0,
    enabled: key === "SCM" || streams.length > 0,
    configurationReady: key === "SCM" || streams.length > 0,
    configurationBinding: `binding:${key}`,
    contractSelectionState: key === "SCM" ? "not_required" : "selected",
    selectedContractCount: streams.length,
    successfulStreams: streams.filter((item) => item.lastSuccessAt != null).length,
    successfulStreamKeys: streams.filter((item) => item.lastSuccessAt != null).map((item) => item.stream),
    streams,
    latestFailedStreams: streams.filter((item) => item.latestStatus === "failed").length,
    latestRunningStreams: streams.filter((item) => item.latestStatus === "running").length,
    sourceRows: streams.reduce((sum, item) => sum + item.sourceRows, 0),
    stagedRows: streams.reduce((sum, item) => sum + item.stagedRows, 0),
    rejectedRows: streams.reduce((sum, item) => sum + item.rejectedRows, 0),
    latestRunAt: streams[0]?.latestRunAt ?? null,
    lastSuccessAt: streams[0]?.lastSuccessAt ?? null,
    sourceAsOfStart: streams[0]?.sourceAsOf ?? null,
    sourceAsOfEnd: streams.at(-1)?.sourceAsOf ?? null,
    openIdentityExceptions: 0,
    observedIdentities: 0,
    identityCoverage: [],
    scmEvidence: {},
    gate: "gate",
    nextAction: "next",
  };
}

function product(
  id: string,
  title: string,
  sla: number,
  requiredStreams: DataProductDefinition["requiredStreams"],
): DataProductDefinition {
  const sources = Object.keys(requiredStreams) as DataProductDefinition["sources"];
  return {
    id,
    title,
    decision: `${title}要回答的决策`,
    grain: "day x sku",
    owner: `${title} owner`,
    ownerRoles: ["pmc"],
    contractVersion: "1.0.0",
    cadence: "daily",
    decisionSlaHours: sla,
    metricIds: ["salesQty"],
    maxAutomation: "A2",
    automationGuardrail: "test",
    sources,
    requiredScmEvidence: [],
    requiredStreams,
    requiredIdentities: {},
    requiredSemantics: {},
    targetAuthority: "operational",
    releaseGate: "test",
  };
}

function approved(productId: string): DataProductReleaseReadiness {
  return {
    productId,
    runtimeLevel: "A1",
    effectiveLevel: "A2",
    eligibleForRequest: false,
    gate: "approved",
    currentScopeDigest: "digest",
    activeRelease: null,
    pendingRelease: null,
    latestRelease: null,
    activeReleaseCurrent: true,
    canRequest: false,
    canApprove: false,
    canReject: false,
    canRevoke: false,
    dependencyGates: [],
  };
}

describe("三方数据资产到业务决策覆盖", () => {
  it("已演练但未选入当前同步的流不计入可解释资产", () => {
    const jdy = source("JIANDAOYUN", [stream("platform-fee-observation", {
      selectedForSync: false,
      releaseBlocked: true,
    })]);
    jdy.selectedStreamKeys = [];
    jdy.availableStreamKeys = ["platform-fee-observation"];

    const portfolio = buildDataAssetDecisionPortfolio([
      product("margin", "净毛利桥", 72, { JIANDAOYUN: ["platform-fee-observation"] }),
    ], [jdy]);

    expect(portfolio.rows[0]).toMatchObject({
      implementationState: "implemented",
      state: "degraded",
      explanationUsable: false,
      stateReason: expect.stringContaining("当前部署未显式选中"),
    });
  });

  it("去重计算一条流影响的多个产品，并保留最短已登记 SLA", () => {
    const products = [
      product("p1", "库存决策", 4, { JST: ["inventory-total-delta"] }),
      product("p2", "补货决策", 24, { JST: ["inventory-total-delta"] }),
    ];
    const portfolio = buildDataAssetDecisionPortfolio(products, [
      source("JST", [stream("inventory-total-delta", { releaseBlocked: true })]),
    ], [approved("p1")]);
    const row = portfolio.rows.find((item) => item.key === "JST:inventory-total-delta")!;

    expect(row).toMatchObject({
      state: "observation",
      explanationUsable: true,
      cataloged: true,
      dependencyCount: 2,
      releasedDependencyCount: 1,
      minDecisionSlaHours: 4,
      actionLabel: "完成产品 UAT",
      actionHref: "/report/decision-studio?tab=readiness&product=p2#data-product-p2",
    });
    expect(row.dependencies.map((item) => item.productId)).toEqual(["p1", "p2"]);
    expect(portfolio).toMatchObject({
      requiredAssetCount: 1,
      explanationUsableCount: 1,
      operationalReadyCount: 0,
      affectedProductCount: 2,
    });
  });

  it("共享资产把 UAT 行动指向首个未放行产品，全部放行后回到总门禁", () => {
    const products = [
      product("p1", "库存决策", 4, { JST: ["inventory-total-delta"] }),
      product("p2", "补货决策", 24, { JST: ["inventory-total-delta"] }),
    ];
    const evidence = [source("JST", [stream("inventory-total-delta", { releaseBlocked: true })])];

    const pending = buildDataAssetDecisionPortfolio(products, evidence, [approved("p1")]);
    expect(pending.rows[0]).toMatchObject({
      actionLabel: "完成产品 UAT",
      actionHref: "/report/decision-studio?tab=readiness&product=p2#data-product-p2",
    });

    const released = buildDataAssetDecisionPortfolio(products, evidence, [approved("p1"), approved("p2")]);
    expect(released.rows[0]).toMatchObject({
      actionLabel: "查看产品门禁",
      actionHref: "/report/decision-studio?tab=readiness",
    });
  });

  it("沿产品依赖图追踪原始资产对下游组合决策的间接影响", () => {
    const demand = product("demand", "需求脉搏", 24, {
      JIANDAOYUN: ["tmall-sku-sales-observation"],
    });
    const replenishment = product("replenishment", "补货证据包", 4, { SCM: [] });
    replenishment.sources = ["SCM"];
    replenishment.requiredScmEvidence = [];
    replenishment.requiredProducts = [{
      productId: "demand",
      minimumLevel: "A2",
      purpose: "复用需求口径",
    }];
    const portfolio = buildDataAssetDecisionPortfolio([demand, replenishment], [
      source("JIANDAOYUN", [stream("tmall-sku-sales-observation", { freshness: "stale" })]),
    ]);
    const row = portfolio.rows.find((item) => item.stream === "tmall-sku-sales-observation")!;

    expect(row).toMatchObject({
      releaseRequired: true,
      requiredDependencyCount: 1,
      supportingDependencyCount: 0,
      nestedDependencyCount: 1,
      dependencyCount: 2,
    });
    expect(row.dependencies).toEqual([
      expect.objectContaining({ productId: "demand", usage: "required", viaProductIds: [] }),
      expect.objectContaining({ productId: "replenishment", usage: "nested", viaProductIds: ["demand"] }),
    ]);
    expect(portfolio.affectedProductCount).toBe(2);
    expect(portfolio.sources.find((item) => item.source === "JIANDAOYUN")?.affectedProductCount).toBe(2);
  });

  it("显式暴露已成功读取但没有任何数据产品消费的流", () => {
    const portfolio = buildDataAssetDecisionPortfolio([
      product("p1", "需求决策", 24, { JIANDAOYUN: ["tmall-sku-sales-observation"] }),
    ], [
      source("JIANDAOYUN", [
        stream("tmall-sku-sales-observation", { releaseBlocked: true }),
        stream("legacy-success-not-in-catalog"),
        stream("legacy-success-not-in-catalog"),
      ]),
    ]);
    const unused = portfolio.rows.find((item) => item.stream === "legacy-success-not-in-catalog")!;

    expect(unused).toMatchObject({
      cataloged: false,
      dependencyCount: 0,
      explanationUsable: true,
      actionLabel: "评估资产用途",
    });
    expect(portfolio.rows.filter((item) => item.stream === "legacy-success-not-in-catalog")).toHaveLength(1);
    expect(portfolio.unusedObservedCount).toBe(1);
    expect(portfolio.sources.find((item) => item.source === "JIANDAOYUN")?.unusedObservedCount).toBe(1);
  });

  it("辅助证据被编入决策但不增加放行依赖，也不因过期阻塞产品", () => {
    const p = product("inventory", "统一库存", 4, { JST: ["inventory-total-delta"] });
    p.supportingStreams = { JIANDAOYUN: ["inventory-count-observation"] };
    const portfolio = buildDataAssetDecisionPortfolio([p], [
      source("JST", [stream("inventory-total-delta")], "operational"),
      source("JIANDAOYUN", [stream("inventory-count-observation", {
        freshness: "stale",
        businessAgeDays: 30,
      })]),
    ]);
    const supporting = portfolio.rows.find((row) => row.stream === "inventory-count-observation")!;

    expect(supporting).toMatchObject({
      cataloged: true,
      releaseRequired: false,
      requiredDependencyCount: 0,
      supportingDependencyCount: 1,
      nestedDependencyCount: 0,
      dependencies: [expect.objectContaining({ productId: "inventory", usage: "supporting" })],
    });
    expect(portfolio).toMatchObject({
      catalogedAssetCount: 2,
      requiredAssetCount: 1,
      supportingOnlyAssetCount: 1,
      affectedProductCount: 0,
      unusedObservedCount: 0,
    });
    expect(portfolio.rows.findIndex((row) => row.stream === "inventory-total-delta"))
      .toBeLessThan(portfolio.rows.findIndex((row) => row.stream === "inventory-count-observation"));
  });

  it("授权/质量受限优先于过期和缺失，不用主观价值分", () => {
    const products = [
      product("degraded", "用友财务", 72, { YONYOU: ["voucher"] }),
      product("stale", "聚水潭履约", 4, { JST: ["orders"] }),
      product("missing", "简道云需求", 4, { JIANDAOYUN: ["sales"] }),
    ];
    const portfolio = buildDataAssetDecisionPortfolio(products, [
      source("YONYOU", [stream("voucher", { authorizationBlocked: true, freshness: "unknown" })]),
      source("JST", [stream("orders", { freshness: "stale", businessAgeDays: 9 })]),
      source("JIANDAOYUN", []),
    ]);

    expect(portfolio.rows.filter((item) => item.cataloged).map((item) => item.state))
      .toEqual(["degraded", "stale", "missing"]);
    expect(portfolio.rows[0]).toMatchObject({ source: "YONYOU", actionLabel: "修复连接证据" });
  });

  it("相同流名仍按来源 scope 隔离，不跨系统串用证据", () => {
    const portfolio = buildDataAssetDecisionPortfolio([
      product("jst", "JST 决策", 24, { JST: ["shared-key"] }),
      product("yy", "YY 决策", 24, { YONYOU: ["shared-key"] }),
    ], [source("JST", [stream("shared-key")], "operational"), source("YONYOU", [])]);

    expect(portfolio.rows.find((item) => item.key === "JST:shared-key")).toMatchObject({
      state: "current",
      dependencyCount: 1,
    });
    expect(portfolio.rows.find((item) => item.key === "YONYOU:shared-key")).toMatchObject({
      state: "missing",
      dependencyCount: 1,
    });
  });

  it("当前连接配置已失效时，不用历史成功批次伪报可解释或运营就绪", () => {
    const jst = source("JST", [stream("orders")], "operational");
    jst.configurationReady = false;
    const portfolio = buildDataAssetDecisionPortfolio([
      product("p1", "履约决策", 24, { JST: ["orders"] }),
    ], [jst]);

    expect(portfolio.rows[0]).toMatchObject({
      state: "degraded",
      explanationUsable: false,
      actionLabel: "修复连接证据",
    });
    expect(portfolio).toMatchObject({ explanationUsableCount: 0, operationalReadyCount: 0 });
  });

  it("当前来源仍被契约门禁阻断时，不用历史成功批次伪报可解释", () => {
    const jst = source("JST", [stream("orders")], "contract_only");
    const portfolio = buildDataAssetDecisionPortfolio([
      product("p1", "履约决策", 24, { JST: ["orders"] }),
    ], [jst]);

    expect(portfolio.rows[0]).toMatchObject({
      state: "degraded",
      explanationUsable: false,
      actionLabel: "修复连接证据",
    });
    expect(portfolio.rows[0].stateReason).toContain("未进入观察或运营状态");
  });

  it("结构漂移批次保留证据但不得计入可解释覆盖", () => {
    const portfolio = buildDataAssetDecisionPortfolio([
      product("p1", "用友库存决策", 4, { YONYOU: ["inventory"] }),
    ], [
      source("YONYOU", [stream("inventory", {
        schemaDrift: true,
        releaseBlocked: true,
      })], "observation"),
    ]);

    expect(portfolio.rows[0]).toMatchObject({
      state: "degraded",
      explanationUsable: false,
      actionLabel: "修复连接证据",
    });
    expect(portfolio.rows[0].stateReason).toContain("外部字段结构变化");
    expect(portfolio).toMatchObject({ explanationUsableCount: 0, operationalReadyCount: 0 });
  });

  it("聚合质量待复核时不得计入可解释覆盖", () => {
    const portfolio = buildDataAssetDecisionPortfolio([
      product("p1", "简道云需求决策", 24, { JIANDAOYUN: ["sales"] }),
    ], [
      source("JIANDAOYUN", [stream("sales", {
        releaseBlocked: true,
        quality: {
          status: "review",
          activeRows: 10,
          deletedRows: 0,
          missingFieldValues: 0,
          missingBusinessKeyRows: 0,
          duplicateKeyGroups: 2,
          duplicateRows: 5,
          invalidNumericValues: 0,
          reconciliationMismatchedRows: 0,
          reconciliationInsufficientRows: 0,
        },
      })], "observation"),
    ]);

    expect(portfolio.rows[0]).toMatchObject({
      state: "degraded",
      explanationUsable: false,
      actionLabel: "修复连接证据",
    });
    expect(portfolio.rows[0].stateReason).toContain("业务键重复 2 组/5 行");
  });

  it("把未实现读取契约与只差授权明确分开", () => {
    const jst = source("JST", []);
    jst.availableStreamKeys = ["outbound-sales-daily"];
    const portfolio = buildDataAssetDecisionPortfolio([
      product("p1", "订单履约", 4, { JST: ["orders-daily"] }),
      product("p2", "出库销量", 24, { JST: ["outbound-sales-daily"] }),
    ], [jst]);

    expect(portfolio.rows.find((row) => row.stream === "orders-daily")).toMatchObject({
      implementationState: "planned",
      state: "missing",
      explanationUsable: false,
      actionLabel: "补齐读取契约",
    });
    expect(portfolio.rows.find((row) => row.stream === "orders-daily")?.stateReason)
      .toContain("尚未实现受控读取契约");
    expect(portfolio.rows.find((row) => row.stream === "orders-daily")?.stateReason)
      .toContain("标准订单接口明确不返回两者");
    expect(portfolio).toMatchObject({
      requiredAssetCount: 2,
      implementedAssetCount: 1,
      plannedAssetCount: 1,
    });
  });

  it("机械列出当前目录中仍只有目标定义的四条三方数据流", () => {
    const jdy = source("JIANDAOYUN", []);
    jdy.availableStreamKeys = [
      "tmall-sku-crosswalk-observation",
      "vip-product-crosswalk-observation",
      "pdd-sku-crosswalk-observation",
      "tmall-sku-sales-observation",
      "tmall-sku-refund-observation",
      "product-master-observation",
      "purchase-demand-observation",
      "purchase-order-observation",
      "purchase-receipt-observation",
      "supplier-observation",
      "warehouse-observation",
      "warehouse-transfer-observation",
      "inventory-count-observation",
      "sample-management-observation",
      "platform-fee-observation",
    ];
    const jst = source("JST", []);
    jst.availableStreamKeys = [
      "inbound-receipts-daily",
      "inventory-total-delta",
      "item-master",
      "outbound-sales-daily",
    ];
    const yonyou = source("YONYOU", []);
    yonyou.availableStreamKeys = [
      "yonbip-uspace-org-page-list",
      "yonbip-digitalmodel-vendor-list",
      "yonbip-digitalmodel-product-listproductbycondition",
      "yonbip-scm-purchaseorder-list",
      "yonbip-scm-purinrecord-list",
      "yonbip-scm-stock-querycurrentstocksbycondition",
      "yonbip-efi-fieia-querybalance",
      "yonbip-fi-ficloud-openapi-voucher-queryvouchers",
    ];

    const portfolio = buildDataAssetDecisionPortfolio(DATA_PRODUCTS, [jdy, jst, yonyou]);
    expect(portfolio.rows
      .filter((row) => row.cataloged && row.implementationState === "planned")
      .map((row) => row.key)
      .sort()).toEqual([
      "JIANDAOYUN:npd-milestone-observation",
      "JST:orders-daily",
      "JST:returns-daily",
      "YONYOU:yonbip-finance-receivables-settlement",
    ]);
    expect(portfolio.plannedAssetCount).toBe(4);
    expect(portfolio.rows.find((row) => row.stream === "returns-daily")?.stateReason)
      .toContain("标准售后接口只返回自有商城");
    expect(portfolio.rows.find((row) => row.stream === "orders-daily")?.stateReason)
      .toContain("jushuitan.order.list.query");
    expect(portfolio.rows.find((row) => row.stream === "returns-daily")?.stateReason)
      .toContain("jushuitan.refund.list.query");
    expect(portfolio.rows.find((row) => row.stream === "yonbip-finance-receivables-settlement")?.stateReason)
      .toContain("目标 YonBIP C4 租户官方 API 目录");
    expect(portfolio.supportingOnlyAssetCount).toBe(6);
    expect(portfolio.rows
      .filter((row) => row.cataloged && !row.releaseRequired)
      .map((row) => row.key)
      .sort()).toEqual([
      "JIANDAOYUN:inventory-count-observation",
      "JIANDAOYUN:purchase-demand-observation",
      "JIANDAOYUN:sample-management-observation",
      "JIANDAOYUN:supplier-observation",
      "JIANDAOYUN:warehouse-observation",
      "JIANDAOYUN:warehouse-transfer-observation",
    ]);
  });

  it("只有近期运行时间但缺源业务截止日时不计入当前或可解释覆盖", () => {
    const portfolio = buildDataAssetDecisionPortfolio([
      product("p1", "聚水潭库存决策", 4, { JST: ["inventory"] }),
    ], [
      source("JST", [stream("inventory", { sourceAsOf: null })], "operational"),
    ]);

    expect(portfolio.rows[0]).toMatchObject({
      state: "degraded",
      explanationUsable: false,
      actionLabel: "修复连接证据",
    });
    expect(portfolio.rows[0].stateReason).toContain("缺少源业务截止日");
    expect(portfolio).toMatchObject({ explanationUsableCount: 0, operationalReadyCount: 0 });
  });
});
