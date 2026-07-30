import {
  parseYonyouApprovedApiContracts,
  parseYonyouProductProfile,
  yonyouConfigFromEnv,
  yonyouMissingEnv,
} from "@/server/integrations/yonyou";

/**
 * Configuration-only audit. It never requests a token, calls a business API, or prints secrets,
 * tenant IDs, organization IDs, endpoints, or contract names.
 */
export function auditYonyouReadiness(env: NodeJS.ProcessEnv = process.env) {
  const missingEnv = yonyouMissingEnv(env);
  const config = yonyouConfigFromEnv(env);
  const contracts = parseYonyouApprovedApiContracts(env.YY_APPROVED_API_CONTRACTS);
  return {
    status: config ? "contract_ready" as const : "blocked" as const,
    implementation: "contract_only" as const,
    safeToCall: false,
    credentialsPresent: {
      appKey: Boolean(env.YY_APP_KEY?.trim() || env.YY_CLIENT_ID?.trim()),
      appSecret: Boolean(env.YY_APP_SECRET?.trim() || env.YY_CLIENT_SECRET?.trim()),
    },
    productProfile: parseYonyouProductProfile(env.YY_PRODUCT_PROFILE),
    approvedApiContractCount: contracts?.length ?? 0,
    endpointPolicy: "HTTPS_PUBLIC_NO_EMBEDDED_CREDENTIALS",
    missingEnv,
    remainingControls: [
      "企业应用与目标企业授权证据",
      "沙箱只读 token 握手",
      "组织/账簿/币种/税/会计期间口径",
      "SKU/供应商外部编码映射",
      "控制总量、限流、错误码与 token 生命周期",
      "只读对账通过后再审批任何写入",
    ],
  };
}
