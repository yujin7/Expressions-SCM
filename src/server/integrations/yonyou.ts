/**
 * 用友 human/C4 login is intentionally not used here. A production integration must be an
 * enterprise-authorized OpenAPI application with its own client credentials, tenant/org identity,
 * approved services, and exact endpoint contracts.
 */
export interface YonyouOpenApiConfig {
  appKey: string;
  appSecret: string;
  tenantId: string;
  orgId: string;
  baseUrl: string;
  tokenUrl: string;
}

export const YONYOU_REQUIRED_ENV = [
  "YY_APP_KEY",
  "YY_APP_SECRET",
  "YY_TENANT_ID",
  "YY_ORG_ID",
  "YY_BASE_URL",
  "YY_TOKEN_URL",
] as const;

export function yonyouMissingEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!(env.YY_APP_KEY?.trim() || env.YY_CLIENT_ID?.trim())) missing.push("YY_APP_KEY");
  if (!(env.YY_APP_SECRET?.trim() || env.YY_CLIENT_SECRET?.trim())) missing.push("YY_APP_SECRET");
  for (const key of ["YY_TENANT_ID", "YY_ORG_ID"] as const) {
    if (!env[key]?.trim()) missing.push(key);
  }
  for (const key of ["YY_BASE_URL", "YY_TOKEN_URL"] as const) {
    const value = env[key]?.trim();
    if (!value || !/^https:\/\//i.test(value)) missing.push(key);
  }
  return missing;
}

export function yonyouConfigFromEnv(env: NodeJS.ProcessEnv = process.env): YonyouOpenApiConfig | null {
  if (yonyouMissingEnv(env).length > 0) return null;
  return {
    appKey: (env.YY_APP_KEY || env.YY_CLIENT_ID)!.trim(),
    appSecret: (env.YY_APP_SECRET || env.YY_CLIENT_SECRET)!.trim(),
    tenantId: env.YY_TENANT_ID!.trim(),
    orgId: env.YY_ORG_ID!.trim(),
    baseUrl: env.YY_BASE_URL!.trim(),
    tokenUrl: env.YY_TOKEN_URL!.trim(),
  };
}
