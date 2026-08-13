import type { AnyDb } from "@/server/import/staging";
import { JstClient, jstConfigFromEnv } from "@/server/integrations/jst";
import {
  jstInventorySyncEnabled,
  syncJstInventoryObservations,
} from "@/server/integrations/jst-inventory-sync";
import { jstSyncActorId, syncJstDailySales } from "@/server/integrations/jst-sync";
import {
  configuredJstGovernedObservationContracts,
  syncJstGovernedObservation,
  type JstGovernedObservationContract,
} from "@/server/integrations/jst-observation-sync";
import { shanghaiToday } from "./reconcile-jst";

export type JstSyncJobResult =
  | { status: "skipped"; reason: string; bizDate: string }
  | ({ status: "succeeded" } & Awaited<ReturnType<typeof syncJstDailySales>>);

export type JstInventorySyncJobResult =
  | { status: "skipped"; reason: string }
  | ({ status: "succeeded" } & Awaited<ReturnType<typeof syncJstInventoryObservations>>);

export type JstGovernedObservationSyncJobResult =
  | { status: "skipped"; reason: string; contract: JstGovernedObservationContract; bizDate: string }
  | ({ status: "succeeded" } & Awaited<ReturnType<typeof syncJstGovernedObservation>>);

/**
 * Safe scheduler entrypoint. Missing configuration is visible as skipped, never a fabricated
 * success; actual pulls still stage for governed release/reconciliation.
 */
export async function runJstSalesSync(
  db: AnyDb,
  bizDate = shanghaiToday(-1),
): Promise<JstSyncJobResult> {
  const config = jstConfigFromEnv();
  const actorId = jstSyncActorId();
  if (!config) {
    return {
      status: "skipped",
      reason: "缺少 JST_APP_KEY/JST_APP_SECRET/JST_ACCESS_TOKEN",
      bizDate,
    };
  }
  if (actorId === null) {
    return {
      status: "skipped",
      reason: "缺少有效 JST_SYNC_ACTOR_ID",
      bizDate,
    };
  }
  const summary = await syncJstDailySales(db, {
    client: new JstClient(config),
    bizDate,
    actorId,
  });
  return { status: "succeeded", ...summary };
}

/**
 * Incremental all-warehouse inventory observation. It is explicitly opt-in because it consumes a
 * separate JST permission/quota and does not become stock truth without warehouse-grain coverage.
 */
export async function runJstInventorySync(db: AnyDb): Promise<JstInventorySyncJobResult> {
  if (!jstInventorySyncEnabled()) {
    return {
      status: "skipped",
      reason: "JST_INVENTORY_SYNC_ENABLED 未启用",
    };
  }
  const config = jstConfigFromEnv();
  const actorId = jstSyncActorId();
  if (!config) {
    return {
      status: "skipped",
      reason: "缺少 JST_APP_KEY/JST_APP_SECRET/JST_ACCESS_TOKEN",
    };
  }
  if (actorId === null) {
    return {
      status: "skipped",
      reason: "缺少有效 JST_SYNC_ACTOR_ID",
    };
  }
  const summary = await syncJstInventoryObservations(db, {
    client: new JstClient(config),
    actorId,
  });
  return { status: "succeeded", ...summary };
}

/**
 * Optional item/receipt observers. Selection is explicit so a deployment cannot start consuming
 * newly granted API scopes merely because code was deployed; the operator must name each stream.
 */
export async function runJstGovernedObservationSync(
  db: AnyDb,
  contract: JstGovernedObservationContract,
  bizDate = shanghaiToday(-1),
): Promise<JstGovernedObservationSyncJobResult> {
  const selected = configuredJstGovernedObservationContracts();
  if (!selected.includes(contract)) {
    return {
      status: "skipped",
      reason: `JST_OBSERVATION_SYNC_CONTRACTS 未启用 ${contract}`,
      contract,
      bizDate,
    };
  }
  const config = jstConfigFromEnv();
  const actorId = jstSyncActorId();
  if (!config) {
    return {
      status: "skipped",
      reason: "缺少 JST_APP_KEY/JST_APP_SECRET/JST_ACCESS_TOKEN",
      contract,
      bizDate,
    };
  }
  if (actorId === null) {
    return {
      status: "skipped",
      reason: "缺少有效 JST_SYNC_ACTOR_ID",
      contract,
      bizDate,
    };
  }
  const summary = await syncJstGovernedObservation(db, {
    client: new JstClient(config),
    contract,
    sourceAsOf: bizDate,
    actorId,
  });
  return { status: "succeeded", ...summary };
}
