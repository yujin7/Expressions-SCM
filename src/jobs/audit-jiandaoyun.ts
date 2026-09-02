import {
  JiandaoyunClient,
  jiandaoyunConfigFromEnv,
  type JiandaoyunForm,
} from "@/server/integrations/jiandaoyun";
import {
  JIANDAOYUN_FORM_CONTRACTS,
  type JiandaoyunFormContract,
} from "@/server/integrations/jiandaoyun-contracts";
import {
  auditJiandaoyunCatalog,
  auditJiandaoyunContracts,
} from "@/server/integrations/jiandaoyun-audit";

export function selectJiandaoyunAuditContracts(
  contractKeys: readonly string[] = [],
): JiandaoyunFormContract[] {
  const requested = [...new Set(contractKeys.map((key) => key.trim()).filter(Boolean))];
  if (requested.length === 0) return [...JIANDAOYUN_FORM_CONTRACTS];

  const byKey = new Map(JIANDAOYUN_FORM_CONTRACTS.map((contract) => [contract.key, contract]));
  const unknown = requested.filter((key) => !byKey.has(key));
  if (unknown.length > 0) {
    throw new Error(`未知简道云契约: ${unknown.join(", ")}`);
  }
  return requested.map((key) => byKey.get(key)!);
}

export async function runJiandaoyunContractAudit(
  options: { contractKeys?: readonly string[] } = {},
) {
  const config = jiandaoyunConfigFromEnv();
  if (!config) {
    return {
      status: "skipped" as const,
      reason: "缺少 JIANDAOYUN_API_KEY",
    };
  }
  const client = new JiandaoyunClient(config);
  const selectedContracts = selectJiandaoyunAuditContracts(options.contractKeys);
  const targeted = Boolean(options.contractKeys?.length);
  let catalog: ReturnType<typeof auditJiandaoyunCatalog> | null = null;
  if (!targeted) {
    const apps = await client.listApps();
    const forms: JiandaoyunForm[] = [];
    for (const app of apps) forms.push(...await client.listForms(app.appId));
    catalog = auditJiandaoyunCatalog(apps, forms, selectedContracts);
  }
  const contracts = await auditJiandaoyunContracts(client, { contracts: selectedContracts });
  return {
    status: "succeeded" as const,
    generatedAt: new Date().toISOString(),
    privacy: "internal-aggregate-business-controls-no-raw-rows",
    scope: {
      mode: targeted ? "selected" as const : "all" as const,
      contractKeys: selectedContracts.map((contract) => contract.key),
      auditedContracts: contracts.length,
      catalogAudited: !targeted,
    },
    catalog,
    contracts,
  };
}
