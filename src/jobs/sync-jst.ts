import type { AnyDb } from "@/server/import/staging";
import { JstClient, jstConfigFromEnv } from "@/server/integrations/jst";
import {
  jstInventorySyncEnabled,
  syncJstInventoryObservations,
} from "@/server/integrations/jst-inventory-sync";
import { jstSyncActorId, syncJstDailySales } from "@/server/integrations/jst-sync";
import { shanghaiToday } from "./reconcile-jst";

export type JstSyncJobResult =
  | { status: "skipped"; reason: string; bizDate: string }
  | ({ status: "succeeded" } & Awaited<ReturnType<typeof syncJstDailySales>>);

export type JstInventorySyncJobResult =
  | { status: "skipped"; reason: string }
  | ({ status: "succeeded" } & Awaited<ReturnType<typeof syncJstInventoryObservations>>);

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
