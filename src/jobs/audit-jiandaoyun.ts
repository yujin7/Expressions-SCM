import {
  JiandaoyunClient,
  jiandaoyunConfigFromEnv,
} from "@/server/integrations/jiandaoyun";
import { auditJiandaoyunContracts } from "@/server/integrations/jiandaoyun-audit";

export async function runJiandaoyunContractAudit() {
  const config = jiandaoyunConfigFromEnv();
  if (!config) {
    return {
      status: "skipped" as const,
      reason: "缺少 JIANDAOYUN_API_KEY",
    };
  }
  const client = new JiandaoyunClient(config);
  const apps = await client.listApps();
  let forms = 0;
  for (const app of apps) forms += (await client.listForms(app.appId)).length;
  const contracts = await auditJiandaoyunContracts(client);
  return {
    status: "succeeded" as const,
    generatedAt: new Date().toISOString(),
    privacy: "aggregate-controls-only",
    catalog: { apps: apps.length, forms },
    contracts,
  };
}
