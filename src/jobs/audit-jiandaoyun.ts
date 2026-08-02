import {
  JiandaoyunClient,
  jiandaoyunConfigFromEnv,
  type JiandaoyunForm,
} from "@/server/integrations/jiandaoyun";
import {
  auditJiandaoyunCatalog,
  auditJiandaoyunContracts,
} from "@/server/integrations/jiandaoyun-audit";

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
  const forms: JiandaoyunForm[] = [];
  for (const app of apps) forms.push(...await client.listForms(app.appId));
  const contracts = await auditJiandaoyunContracts(client);
  return {
    status: "succeeded" as const,
    generatedAt: new Date().toISOString(),
    privacy: "internal-aggregate-business-controls-no-raw-rows",
    catalog: auditJiandaoyunCatalog(apps, forms),
    contracts,
  };
}
