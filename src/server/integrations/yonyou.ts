/**
 * 用友 human/C4 login is intentionally not used here. A production integration must be an
 * enterprise-authorized OpenAPI application with its own client credentials, tenant/org identity,
 * approved services, and exact endpoint contracts.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { areKnownYonyouReadContracts } from "./yonyou-contracts";

export interface YonyouOpenApiConfig {
  appKey: string;
  appSecret: string;
  tenantId: string;
  orgId: string;
  productProfile: YonyouProductProfile;
  approvedApiContracts: string[];
  allowedHosts: string[];
  baseUrl: string;
  tokenUrl: string;
}

export const YONYOU_PRODUCT_PROFILES = ["c4", "yonsuite", "yonbip"] as const;
export type YonyouProductProfile = (typeof YONYOU_PRODUCT_PROFILES)[number];

const YONYOU_UAT_CONTRACT_VERSION = "yonyou-uat-v1";
const YONYOU_LIVE_BINDING_PREFIX = "YY1_";

export const YONYOU_REQUIRED_ENV = [
  "YY_APP_KEY",
  "YY_APP_SECRET",
  "YY_TENANT_ID",
  "YY_ORG_ID",
  "YY_PRODUCT_PROFILE",
  "YY_APPROVED_API_CONTRACTS",
  "YY_ALLOWED_HOSTS",
  "YY_BASE_URL",
  "YY_TOKEN_URL",
] as const;

export function parseYonyouAllowedHosts(
  raw: string | null | undefined,
): string[] | null {
  if (!raw?.trim()) return null;
  const hosts = [...new Set(raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (
    hosts.length === 0
    || hosts.length > 10
    || hosts.some((host) => (
      host.length > 253
      || host.includes("%")
      || isIP(host) !== 0
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    ))
  ) return null;
  return hosts;
}

/**
 * Future token clients will send the AppSecret to tokenUrl, so endpoints are treated as a
 * credential-exfiltration boundary. Only an explicit enterprise-reviewed host allowlist is
 * accepted here; a future network client must additionally call assertYonyouDnsResolutionSafe
 * immediately before connecting and pin the verified address for that request.
 */
export function isSafeYonyouEndpoint(
  raw: string | null | undefined,
  allowedHosts: readonly string[] | null,
): boolean {
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
      || hostname.includes("%")
      || isIP(hostname) !== 0
      || !allowedHosts?.includes(hostname)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) nonPublicAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) nonPublicAddresses.addSubnet(network, prefix, "ipv6");

export function isPublicYonyouAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublicAddresses.check(address, "ipv4");
  if (family === 6) {
    if (address.toLowerCase().startsWith("::ffff:")) return false;
    return !nonPublicAddresses.check(address, "ipv6");
  }
  return false;
}

type DnsLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

/**
 * DNS-rebinding guard for the future HTTP client. Validation and the request must share/pin the
 * returned address; resolving again inside a generic fetch would reopen the rebinding window.
 */
export async function assertYonyouDnsResolutionSafe(
  endpoint: string,
  lookup: DnsLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<readonly { address: string; family: number }[]> {
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicYonyouAddress(address))) {
    throw new Error("用友 endpoint DNS 解析包含非公网地址；拒绝发送机器凭据");
  }
  return addresses;
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
    || !areKnownYonyouReadContracts(values)
  ) return null;
  return values;
}

export function yonyouSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes"].includes(
    env.YY_SYNC_ENABLED?.trim().toLowerCase() ?? "",
  );
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
  const allowedHosts = parseYonyouAllowedHosts(env.YY_ALLOWED_HOSTS);
  if (!allowedHosts) missing.push("YY_ALLOWED_HOSTS");
  for (const key of ["YY_BASE_URL", "YY_TOKEN_URL"] as const) {
    const value = env[key]?.trim();
    if (!isSafeYonyouEndpoint(value, allowedHosts)) missing.push(key);
  }
  return [...new Set(missing)];
}

export function yonyouConfigFromEnv(env: NodeJS.ProcessEnv = process.env): YonyouOpenApiConfig | null {
  if (yonyouMissingEnv(env).length > 0) return null;
  const appKey = env.YY_APP_KEY?.trim() || env.YY_CLIENT_ID?.trim();
  const appSecret = env.YY_APP_SECRET?.trim() || env.YY_CLIENT_SECRET?.trim();
  return {
    appKey: appKey!,
    appSecret: appSecret!,
    tenantId: env.YY_TENANT_ID!.trim(),
    orgId: env.YY_ORG_ID!.trim(),
    productProfile: parseYonyouProductProfile(env.YY_PRODUCT_PROFILE)!,
    approvedApiContracts: parseYonyouApprovedApiContracts(env.YY_APPROVED_API_CONTRACTS)!,
    allowedHosts: parseYonyouAllowedHosts(env.YY_ALLOWED_HOSTS)!,
    baseUrl: env.YY_BASE_URL!.trim(),
    tokenUrl: env.YY_TOKEN_URL!.trim(),
  };
}

/**
 * Binds a dated UAT reference to the exact non-secret integration scope. The digest includes the
 * application identity, tenant/organization, product, approved contracts and reviewed endpoints,
 * so changing any of those facts invalidates old evidence without exposing them in readiness JSON.
 * AppSecret rotation intentionally does not invalidate evidence for the same application scope.
 */
export function yonyouLiveEvidenceBinding(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const config = yonyouConfigFromEnv(env);
  if (!config) return null;
  const digest = createHash("sha256").update(JSON.stringify({
    contract: YONYOU_UAT_CONTRACT_VERSION,
    appKey: config.appKey,
    tenantId: config.tenantId,
    orgId: config.orgId,
    productProfile: config.productProfile,
    approvedApiContracts: [...config.approvedApiContracts].sort(),
    allowedHosts: [...config.allowedHosts].sort(),
    baseUrl: config.baseUrl,
    tokenUrl: config.tokenUrl,
  }), "utf8").digest("hex").slice(0, 24).toUpperCase();
  return `${YONYOU_LIVE_BINDING_PREFIX}${digest}`;
}

export function yonyouEvidenceRefHasLiveBinding(
  evidenceRef: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const binding = yonyouLiveEvidenceBinding(env);
  if (!binding || !evidenceRef) return false;
  return evidenceRef === binding || evidenceRef.endsWith(`-${binding}`);
}
