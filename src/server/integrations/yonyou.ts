/**
 * 用友 human/C4 login is intentionally not used here. A production integration must be an
 * enterprise-authorized OpenAPI application with its own client credentials, tenant/org identity,
 * approved services, and exact endpoint contracts.
 */
import { isIP } from "node:net";

export interface YonyouOpenApiConfig {
  appKey: string;
  appSecret: string;
  tenantId: string;
  orgId: string;
  productProfile: YonyouProductProfile;
  approvedApiContracts: string[];
  baseUrl: string;
  tokenUrl: string;
}

export const YONYOU_PRODUCT_PROFILES = ["c4", "yonsuite", "yonbip"] as const;
export type YonyouProductProfile = (typeof YONYOU_PRODUCT_PROFILES)[number];

export const YONYOU_REQUIRED_ENV = [
  "YY_APP_KEY",
  "YY_APP_SECRET",
  "YY_TENANT_ID",
  "YY_ORG_ID",
  "YY_PRODUCT_PROFILE",
  "YY_APPROVED_API_CONTRACTS",
  "YY_BASE_URL",
  "YY_TOKEN_URL",
] as const;

/**
 * Future token clients will send the AppSecret to tokenUrl, so endpoints are treated as a
 * credential-exfiltration boundary. Do not accept HTTP, embedded credentials, loopback or private
 * network targets from an environment typo.
 */
export function isSafeYonyouEndpoint(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      !hostname
      || hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".internal")
      || hostname.endsWith(".invalid")
      || hostname.endsWith(".test")
      || hostname.endsWith(".example")
      || isIP(hostname) !== 0
    ) return false;
    return true;
  } catch {
    return false;
  }
}

export function parseYonyouProductProfile(
  raw: string | null | undefined,
): YonyouProductProfile | null {
  const value = raw?.trim().toLowerCase();
  return YONYOU_PRODUCT_PROFILES.includes(value as YonyouProductProfile)
    ? value as YonyouProductProfile
    : null;
}

export function parseYonyouApprovedApiContracts(
  raw: string | null | undefined,
): string[] | null {
  if (!raw?.trim()) return null;
  const values = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (
    values.length === 0
    || values.length > 50
    || values.some((value) => value.length > 160 || /[\u0000-\u001f\u007f]/.test(value))
  ) return null;
  return values;
}

function conflictingAliases(
  primary: string | undefined,
  alias: string | undefined,
): boolean {
  return Boolean(primary?.trim() && alias?.trim() && primary.trim() !== alias.trim());
}

export function yonyouMissingEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!(env.YY_APP_KEY?.trim() || env.YY_CLIENT_ID?.trim())) missing.push("YY_APP_KEY");
  if (!(env.YY_APP_SECRET?.trim() || env.YY_CLIENT_SECRET?.trim())) missing.push("YY_APP_SECRET");
  if (conflictingAliases(env.YY_APP_KEY, env.YY_CLIENT_ID)) {
    missing.push("YY_APP_KEY", "YY_CLIENT_ID");
  }
  if (conflictingAliases(env.YY_APP_SECRET, env.YY_CLIENT_SECRET)) {
    missing.push("YY_APP_SECRET", "YY_CLIENT_SECRET");
  }
  for (const key of ["YY_TENANT_ID", "YY_ORG_ID"] as const) {
    if (!env[key]?.trim()) missing.push(key);
  }
  if (!parseYonyouProductProfile(env.YY_PRODUCT_PROFILE)) missing.push("YY_PRODUCT_PROFILE");
  if (!parseYonyouApprovedApiContracts(env.YY_APPROVED_API_CONTRACTS)) {
    missing.push("YY_APPROVED_API_CONTRACTS");
  }
  for (const key of ["YY_BASE_URL", "YY_TOKEN_URL"] as const) {
    const value = env[key]?.trim();
    if (!isSafeYonyouEndpoint(value)) missing.push(key);
  }
  return [...new Set(missing)];
}

export function yonyouConfigFromEnv(env: NodeJS.ProcessEnv = process.env): YonyouOpenApiConfig | null {
  if (yonyouMissingEnv(env).length > 0) return null;
  return {
    appKey: (env.YY_APP_KEY || env.YY_CLIENT_ID)!.trim(),
    appSecret: (env.YY_APP_SECRET || env.YY_CLIENT_SECRET)!.trim(),
    tenantId: env.YY_TENANT_ID!.trim(),
    orgId: env.YY_ORG_ID!.trim(),
    productProfile: parseYonyouProductProfile(env.YY_PRODUCT_PROFILE)!,
    approvedApiContracts: parseYonyouApprovedApiContracts(env.YY_APPROVED_API_CONTRACTS)!,
    baseUrl: env.YY_BASE_URL!.trim(),
    tokenUrl: env.YY_TOKEN_URL!.trim(),
  };
}
