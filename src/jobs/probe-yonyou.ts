import {
  connectorProbeEvidence,
  type ConnectorProbeEvidence,
} from "@/server/integrations/connector-probe-evidence";
import { IntegrationHttpError } from "@/server/integrations/http";
import { YonyouApiError, YonyouClient } from "@/server/integrations/yonyou-client";
import {
  YONYOU_READ_CONTRACTS,
  type YonyouReadContractName,
} from "@/server/integrations/yonyou-contracts";
import {
  isSafeYonyouEndpoint,
  parseYonyouAllowedHosts,
  parseYonyouProductProfile,
  type YonyouOpenApiConfig,
  yonyouLiveEvidenceBinding,
} from "@/server/integrations/yonyou";

type YonyouProbeClient = Pick<YonyouClient, "getAccessToken" | "callContract">;

function probeConfigFromEnv(env: NodeJS.ProcessEnv): {
  config: YonyouOpenApiConfig | null;
  reason: "missing_configuration" | "invalid_configuration";
} {
  const primaryKey = env.YY_APP_KEY?.trim();
  const aliasKey = env.YY_CLIENT_ID?.trim();
  const primarySecret = env.YY_APP_SECRET?.trim();
  const aliasSecret = env.YY_CLIENT_SECRET?.trim();
  const appKey = primaryKey || aliasKey;
  const appSecret = primarySecret || aliasSecret;
  if (!appKey || !appSecret) return { config: null, reason: "missing_configuration" };
  if (
    (primaryKey && aliasKey && primaryKey !== aliasKey)
    || (primarySecret && aliasSecret && primarySecret !== aliasSecret)
  ) return { config: null, reason: "invalid_configuration" };
  const productProfile = parseYonyouProductProfile(env.YY_PRODUCT_PROFILE);
  const allowedHosts = parseYonyouAllowedHosts(env.YY_ALLOWED_HOSTS);
  const baseUrl = env.YY_BASE_URL?.trim();
  const tokenUrl = env.YY_TOKEN_URL?.trim();
  if (
    !productProfile
    || !allowedHosts
    || !isSafeYonyouEndpoint(baseUrl, allowedHosts)
    || !isSafeYonyouEndpoint(tokenUrl, allowedHosts)
  ) return { config: null, reason: "invalid_configuration" };
  return {
    config: {
      appKey,
      appSecret,
      // The permission probe does not read tenant-scoped business rows into SCM. These placeholders
      // never leave the process; full sync still requires real tenant/org values and remains blocked.
      tenantId: env.YY_TENANT_ID?.trim() || "probe-only",
      orgId: env.YY_ORG_ID?.trim() || "probe-only",
      productProfile,
      approvedApiContracts: YONYOU_READ_CONTRACTS.map((contract) => contract.name),
      allowedHosts,
      baseUrl: baseUrl!,
      tokenUrl: tokenUrl!,
    },
    reason: "missing_configuration",
  };
}

function safeYonyouProbeError(error: unknown): string {
  if (error instanceof YonyouApiError && /^[A-Za-z0-9_-]{1,24}$/.test(error.code)) {
    return `api_code_${error.code}`;
  }
  if (error instanceof IntegrationHttpError) {
    return error.status === null ? "network_or_timeout" : `http_${error.status}`;
  }
  return "unexpected_response";
}

/**
 * Read-only Yonyou authorization probe. It exercises only the eight code-reviewed query
 * contracts, requests at most one row per contract, and returns no token, endpoint, tenant,
 * organization, vendor identifier or response body.
 */
export async function runYonyouPermissionProbe(
  options: { env?: NodeJS.ProcessEnv; client?: YonyouProbeClient } = {},
): Promise<ConnectorProbeEvidence> {
  const env = options.env ?? process.env;
  const probeConfig = probeConfigFromEnv(env);
  const config = probeConfig.config;
  const binding = yonyouLiveEvidenceBinding(env);
  if (!config) {
    return connectorProbeEvidence({
      c: "yy",
      s: "skipped",
      a: "not_checked",
      p: 0,
      t: YONYOU_READ_CONTRACTS.length,
      r: [probeConfig.reason],
      b: binding,
    });
  }

  // The probe's allowlist is the complete code-reviewed read-only catalog. Runtime sync remains
  // narrower and still obeys YY_APPROVED_API_CONTRACTS from the environment.
  const client = options.client ?? new YonyouClient({
    ...config,
  }, { retries: 0 });

  try {
    await client.getAccessToken();
  } catch (error) {
    return connectorProbeEvidence({
      c: "yy",
      s: "partial",
      a: "not_validated",
      p: 0,
      t: YONYOU_READ_CONTRACTS.length,
      r: [safeYonyouProbeError(error)],
      b: binding,
    });
  }

  const results: string[] = [];
  for (const contract of YONYOU_READ_CONTRACTS) {
    try {
      await client.callContract(
        contract.name as YonyouReadContractName,
        { pageIndex: 1, pageSize: 1 },
      );
      results.push("ok");
    } catch (error) {
      results.push(safeYonyouProbeError(error));
    }
  }
  return connectorProbeEvidence({
    c: "yy",
    s: "partial",
    a: "validated",
    p: 0,
    t: YONYOU_READ_CONTRACTS.length,
    r: results,
    b: binding,
  });
}
