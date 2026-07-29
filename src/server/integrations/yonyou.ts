/**
 * 用友 human/C4 login is intentionally not used here. A production integration must be an
 * enterprise-authorized OpenAPI application with its own client credentials, tenant/org identity,
 * approved services, and exact endpoint contracts.
 */
export interface YonyouOpenApiConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  orgId: string;
  baseUrl: string;
  tokenUrl: string;
}

export const YONYOU_REQUIRED_ENV = [
  "YY_CLIENT_ID",
  "YY_CLIENT_SECRET",
  "YY_TENANT_ID",
  "YY_ORG_ID",
  "YY_BASE_URL",
  "YY_TOKEN_URL",
] as const;

export function yonyouConfigFromEnv(env: NodeJS.ProcessEnv = process.env): YonyouOpenApiConfig | null {
  const values = Object.fromEntries(
    YONYOU_REQUIRED_ENV.map((key) => [key, env[key]?.trim() || null]),
  ) as Record<(typeof YONYOU_REQUIRED_ENV)[number], string | null>;
  if (YONYOU_REQUIRED_ENV.some((key) => values[key] === null)) return null;
  return {
    clientId: values.YY_CLIENT_ID!,
    clientSecret: values.YY_CLIENT_SECRET!,
    tenantId: values.YY_TENANT_ID!,
    orgId: values.YY_ORG_ID!,
    baseUrl: values.YY_BASE_URL!,
    tokenUrl: values.YY_TOKEN_URL!,
  };
}
