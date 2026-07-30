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

type JiandaoyunSkipped = { status: "skipped"; reason: string };

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
  return { status: "succeeded" as const, ...summary };
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
  return {
    status: "succeeded" as const,
    contracts: results.length,
    results,
  };
}
