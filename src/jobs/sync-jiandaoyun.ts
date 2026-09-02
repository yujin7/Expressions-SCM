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
} from "@/server/integrations/jiandaoyun-sync";
import { refreshJiandaoyunExternalDemandReadModel } from "@/server/modules/report/external-demand-signal";
import { refreshPlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";

type JiandaoyunSkipped = { status: "skipped"; reason: string };
const EXTERNAL_DEMAND_CONTRACTS = new Set([
  "tmall-sku-crosswalk-observation",
  "tmall-sku-sales-observation",
  "tmall-sku-refund-observation",
]);

async function refreshDemandReadModel(db: AnyDb) {
  const signal = await refreshJiandaoyunExternalDemandReadModel(db);
  // 身份缺口读模型与需求信号绑定同一批次，随同步一起重建，页面不再现算
  const identityGap = await refreshPlatformSkuIdentityGap(db);
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
  return { status: "succeeded" as const, ...summary, readModel };
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
  const results = [];
  for (const contract of contracts) {
    results.push(await syncJiandaoyunForm(db, { ...ready, contract }));
  }
  const readModel = [...EXTERNAL_DEMAND_CONTRACTS]
    .every((key) => contracts.some((contract) => contract.key === key))
    ? await refreshDemandReadModel(db)
    : null;
  return {
    status: "succeeded" as const,
    contracts: results.length,
    results,
    readModel,
  };
}
