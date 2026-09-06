import type { AnyDb } from "@/server/import/staging";
import {
  configuredJiandaoyunContracts,
  jiandaoyunContract,
} from "@/server/integrations/jiandaoyun-contracts";
import {
  JiandaoyunClient,
  jiandaoyunConfigFromEnv,
  jiandaoyunEnabled,
  jiandaoyunSyncActorId,
} from "@/server/integrations/jiandaoyun";
import {
  syncJiandaoyunCatalog,
  syncJiandaoyunForm,
  type JiandaoyunFormSummary,
} from "@/server/integrations/jiandaoyun-sync";
import { refreshJiandaoyunExternalDemandReadModel } from "@/server/modules/report/external-demand-signal";
import { refreshPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { refreshExternalVelocity } from "@/server/modules/report/external-velocity";
import { refreshChannelObservation } from "@/server/modules/report/channel-observation";
import { refreshBondedOutbound } from "@/server/modules/report/bonded-outbound";

type JiandaoyunSkipped = { status: "skipped"; reason: string };
const EXTERNAL_DEMAND_CONTRACTS = new Set([
  "tmall-sku-crosswalk-observation",
  "tmall-sku-sales-observation",
  "tmall-sku-refund-observation",
  // 2026-09-02 第三阶段：这些流进来后同样要重建身份缺口 / 外部销速 / 全渠道观察
  "tmall-unit-daily-observation",
  "pdd-order-observation",
  "pdd-sku-crosswalk-observation",
  "vip-shop-trading-observation",
  "tmall-product-pnl-observation",
  // 2026-09-03 第四阶段：身份桥/组合表/成本标准/条码来源变了也要重建
  "tmall-bundle-detail-observation",
  "pdd-sku-cost-standard-observation",
  "finance-goods-master-observation",
  "jst-item-master-mirror-observation",
  "vip-bundle-crosswalk-observation",
  "tmall-product-traffic-observation",
  "tmall-sku-cost-pnl-observation",
  // 2026-09-03 W2-J：全渠道观察 /v4 用店铺档案/品牌档案归属品牌、接入拼多多日级流；变了同样要重建
  "shop-master-observation",
  "brand-master-observation",
  "pdd-product-daily-observation",
  "pdd-shop-daily-observation",
]);
/** 保税仓出库观察（bonded-outbound/v1）只绑定保税订单流 */
const BONDED_OUTBOUND_CONTRACTS = new Set(["bonded-warehouse-order-observation"]);

export function shouldRefreshBondedOutbound(contractKeys: readonly string[]): boolean {
  return contractKeys.some((key) => BONDED_OUTBOUND_CONTRACTS.has(key));
}

export function shouldRefreshJiandaoyunDemandModels(contractKeys: readonly string[]): boolean {
  return contractKeys.some((key) => EXTERNAL_DEMAND_CONTRACTS.has(key));
}

async function refreshDemandReadModel(db: AnyDb) {
  const models: {
    signal?: Awaited<ReturnType<typeof refreshJiandaoyunExternalDemandReadModel>>;
    identityGap?: Awaited<ReturnType<typeof refreshPlatformSkuIdentityGap>>;
  } = {};
  const failures: Error[] = [];
  // 四个缓存仍顺序刷新，不放大数据库负载；其中一个失败不能让其他已接收事实一直留在旧缓存。
  for (const step of [
    { key: "demand-signal", run: async () => { models.signal = await refreshJiandaoyunExternalDemandReadModel(db); } },
    { key: "external-velocity", run: async () => { await refreshExternalVelocity(db); } },
    { key: "channel-observation", run: async () => { await refreshChannelObservation(db); } },
    { key: "identity-gap", run: async () => { models.identityGap = await refreshPlatformSkuIdentityGap(db); } },
  ]) {
    try {
      await step.run();
    } catch (cause) {
      failures.push(new Error(step.key, { cause }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `需求读模型刷新失败 ${failures.length}/4：${failures.map((error) => error.message).join("、")}`);
  }
  const { signal, identityGap } = models;
  if (!signal || !identityGap) throw new Error("需求读模型未返回完整摘要");
  return {
    state: signal.state,
    sourceAsOf: signal.sourceAsOf,
    crosswalkAsOf: signal.crosswalkAsOf,
    salesRows: signal.coverage.salesRows,
    mappedIdentities: signal.coverage.mappedIdentities,
    platformIdentities: signal.coverage.platformIdentities,
    identityGap: {
      state: identityGap.state,
      platformSkus: identityGap.totals.platformSkus,
      mappedAmountPct: identityGap.totals.mappedAmountPct,
      coverableAmountPct: identityGap.totals.coverableAmountPct,
      unmappedWithCandidates: identityGap.totals.unmappedWithCandidates,
    },
    decisionBrief: {
      state: signal.decisionBrief.state,
      anchorDate: signal.decisionBrief.anchorDate,
      currentObservedDays: signal.decisionBrief.current.observedDays,
      previousObservedDays: signal.decisionBrief.previous.observedDays,
      netDemandChangePct: signal.decisionBrief.change.netQtyPct,
      refundRateDeltaPp: signal.decisionBrief.change.refundRateDeltaPp,
      mappedPaidCoverageDeltaPp: signal.decisionBrief.change.mappedPaidCoverageDeltaPp,
    },
    refundDrivers: {
      state: signal.refundDrivers.state,
      movement: signal.refundDrivers.movement,
      deltaRefundQty: signal.refundDrivers.totals.deltaRefundQty,
      eligibleDrivers: signal.refundDrivers.eligibleDrivers,
      surfacedDrivers: signal.refundDrivers.topContributors.length,
      mappedDrivers: signal.refundDrivers.identityCoverage.mappedDrivers,
      mappedMovementPoolPct: signal.refundDrivers.identityCoverage.mappedMovementPoolPct,
      leadingShop: signal.refundDrivers.byShop[0]?.shopName ?? null,
      leadingShopMovementPoolPct: signal.refundDrivers.byShop[0]?.movementPoolSharePct ?? null,
    },
  };
}

async function refreshBondedOutboundSummary(db: AnyDb) {
  const model = await refreshBondedOutbound(db);
  return {
    state: model.state,
    sourceAsOf: model.sourceAsOf,
    anchorDate: model.anchorDate,
    batches: model.batches,
    qty30: model.totals.qty30,
    orders30: model.totals.orders30,
    skuMappedPct: model.totals.skuMappedPct,
    warehouses: model.byWarehouse.length,
  };
}

function runtime():
  | { client: JiandaoyunClient; actorId: number }
  | JiandaoyunSkipped {
  if (!jiandaoyunEnabled()) {
    return {
      status: "skipped",
      reason: "JIANDAOYUN_SYNC_ENABLED 未启用",
    };
  }
  const config = jiandaoyunConfigFromEnv();
  if (!config) {
    return {
      status: "skipped",
      reason: "缺少 JIANDAOYUN_API_KEY",
    };
  }
  const actorId = jiandaoyunSyncActorId();
  if (actorId === null) {
    return {
      status: "skipped",
      reason: "缺少有效 JIANDAOYUN_SYNC_ACTOR_ID",
    };
  }
  return { client: new JiandaoyunClient(config), actorId };
}

export async function runJiandaoyunCatalogSync(db: AnyDb) {
  const ready = runtime();
  if ("status" in ready) return ready;
  const summary = await syncJiandaoyunCatalog(db, ready);
  return { status: "succeeded" as const, ...summary };
}

export async function runJiandaoyunContractSync(
  db: AnyDb,
  contractKey: string,
) {
  const ready = runtime();
  if ("status" in ready) return ready;
  const contract = jiandaoyunContract(contractKey);
  if (!contract) throw new Error(`未知简道云观察契约: ${contractKey}`);
  const summary = await syncJiandaoyunForm(db, { ...ready, contract });
  const readModel = EXTERNAL_DEMAND_CONTRACTS.has(contract.key)
    ? await refreshDemandReadModel(db)
    : null;
  const bondedOutbound = BONDED_OUTBOUND_CONTRACTS.has(contract.key)
    ? await refreshBondedOutboundSummary(db)
    : null;
  return { status: "succeeded" as const, ...summary, readModel, bondedOutbound };
}

export async function runJiandaoyunConfiguredFormSyncs(db: AnyDb) {
  const ready = runtime();
  if ("status" in ready) return ready;
  const contracts = configuredJiandaoyunContracts();
  if (contracts.length === 0) {
    return {
      status: "skipped" as const,
      reason: "JIANDAOYUN_SYNC_CONTRACTS 未显式选择任何观察契约",
    };
  }
  const results: JiandaoyunFormSummary[] = [];
  const streamFailures: Error[] = [];
  for (const contract of contracts) {
    try {
      // 单流事务、幂等回放及失败留痕由 syncJiandaoyunForm 原样负责。
      // 一条流拒绝替代不阻断其他显式选中的流，也不并行放大外部配额。
      results.push(await syncJiandaoyunForm(db, { ...ready, contract }));
    } catch (cause) {
      streamFailures.push(new Error(contract.key, { cause }));
    }
  }
  const succeededKeys = results.map((result) => result.contractKey);
  const refreshFailures: Error[] = [];
  let readModel: Awaited<ReturnType<typeof refreshDemandReadModel>> | null = null;
  let bondedOutbound: Awaited<ReturnType<typeof refreshBondedOutboundSummary>> | null = null;
  if (shouldRefreshJiandaoyunDemandModels(succeededKeys)) {
    try {
      readModel = await refreshDemandReadModel(db);
    } catch (cause) {
      refreshFailures.push(new Error("demand-models", { cause }));
    }
  }
  if (shouldRefreshBondedOutbound(succeededKeys)) {
    try {
      bondedOutbound = await refreshBondedOutboundSummary(db);
    } catch (cause) {
      refreshFailures.push(new Error("bonded-outbound", { cause }));
    }
  }
  if (streamFailures.length > 0 || refreshFailures.length > 0) {
    // 调度/手跑仅把抛错记为 job_runs.ok=false；返回 partial 对象会被误报为恢复成功。
    // 数量放在最前面，失败键给有界样例；原因留在 cause，不把上游原始响应塞入500字运维摘要。
    const sample = (failures: Error[]) => failures.slice(0, 5).map((error) => error.message).join("、")
      + (failures.length > 5 ? "等" : "");
    throw new AggregateError([...streamFailures, ...refreshFailures],
      `简道云同步未全部完成：成功 ${results.length}/${contracts.length} 流，失败 ${streamFailures.length} 流，刷新失败 ${refreshFailures.length} 组；`
      + `失败流：${sample(streamFailures) || "无"}；刷新失败：${sample(refreshFailures) || "无"}`);
  }
  return {
    status: "succeeded" as const,
    contracts: results.length,
    results,
    readModel,
    bondedOutbound,
  };
}
