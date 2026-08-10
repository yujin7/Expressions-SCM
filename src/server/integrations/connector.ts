import {
  feishuAppConfigFromEnv,
  feishuAppCredentialsFromEnv,
  feishuEvidenceRefHasPermissionReviewBinding,
  feishuEvidenceRefHasTargetBinding,
  feishuPermissionReviewEvidenceBinding,
  feishuTargetEvidenceBinding,
  feishuWebhookUrlFromEnv,
  type FeishuLeastPrivilegeState,
} from "./feishu";
import {
  jiandaoyunConfigFromEnv,
  jiandaoyunEnabled,
  jiandaoyunSyncActorId,
  normalizeJiandaoyunBaseUrl,
} from "./jiandaoyun";
import {
  configuredJiandaoyunContracts,
  jiandaoyunContractSetEvidenceBinding,
  jiandaoyunEvidenceRefHasContractSetBinding,
} from "./jiandaoyun-contracts";
import {
  jstConfigFromEnv,
  jstEvidenceRefHasLiveBinding,
  jstLiveEvidenceBinding,
  normalizeJstBaseUrl,
} from "./jst";
import { jstInventorySyncEnabled } from "./jst-inventory-sync";
import {
  YONYOU_REQUIRED_ENV,
  parseYonyouApprovedApiContracts,
  yonyouConfigFromEnv,
  yonyouEvidenceRefHasLiveBinding,
  yonyouLiveEvidenceBinding,
  yonyouMissingEnv,
  yonyouSyncEnabled,
} from "./yonyou";

export type ConnectorImplementation = "ready" | "contract_only";
export type ConnectorAuth = "signed_token" | "api_key" | "oauth_app" | "webhook_or_app";
export type LiveVerificationState =
  | "missing"
  | "missing_evidence"
  | "invalid"
  | "unbound"
  | "future"
  | "stale"
  | "valid";
export type ConnectorEnablementState = "not_required" | "disabled" | "enabled" | "invalid";
export type ConnectorContractSelectionState =
  | "not_required"
  | "missing"
  | "invalid"
  | "selected";
export type ConnectorIdentityScope = "JST" | "JIANDAOYUN" | "YONYOU";
export type IdentityClearanceState = "not_required" | "unknown" | "blocked" | "clear";
export type ConnectorSecurityReviewState = "not_required" | LiveVerificationState;

export interface ConnectorIdentityEvidence {
  openExceptions: number;
  /** Resolved/ignored exceptions, scoped aliases or scoped identifiers proving this scope was seen. */
  observedIdentities: number;
}

/**
 * Current read-only evidence from Feishu's self-application endpoint. Callers must pass the
 * observation produced in the same readiness operation; persisted configuration is not accepted
 * as proof of the provider's current permission set.
 */
export interface ConnectorFeishuPermissionEvidence {
  appId: string;
  fingerprint: string | null;
  leastPrivilege: FeishuLeastPrivilegeState;
}

export interface ConnectorRuntimeEvidence {
  feishuPermission?: ConnectorFeishuPermissionEvidence;
}

export const LIVE_VERIFICATION_MAX_AGE_DAYS = 90;
const LIVE_VERIFICATION_MAX_AGE_MS = LIVE_VERIFICATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export interface Connector {
  key: "jst" | "jdy" | "yy" | "feishu";
  label: string;
  implementation: ConnectorImplementation;
  auth: ConnectorAuth;
  systemOfRecord: string;
  capabilities: string[];
  requiredEnv: string[];
  optionalEnv: string[];
  liveVerificationEnv?: string;
  liveVerificationRefEnv?: string;
  sourceDocs: string[];
  blocker?: string;
  isConfigured(env?: NodeJS.ProcessEnv): boolean;
  missingEnv(env?: NodeJS.ProcessEnv): string[];
}

interface ConnectorActivation {
  enablementState: ConnectorEnablementState;
  contractSelectionState: ConnectorContractSelectionState;
  selectedContractCount: number;
}

function missing(keys: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return keys.filter((key) => !env[key]?.trim());
}

function feishuMissing(env: NodeJS.ProcessEnv = process.env): string[] {
  if (feishuWebhookUrlFromEnv(env)) return [];
  const appPath = missing(["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID"], env);
  if (appPath.length === 0) return [];
  return [
    ...(env.FEISHU_WEBHOOK_URL?.trim() ? ["FEISHU_WEBHOOK_URL"] : []),
    ...appPath,
  ];
}

function jiandaoyunActivation(env: NodeJS.ProcessEnv): ConnectorActivation {
  const rawEnablement = env.JIANDAOYUN_SYNC_ENABLED?.trim().toLowerCase() ?? "";
  const enablementState: ConnectorEnablementState = jiandaoyunEnabled(env)
    ? "enabled"
    : rawEnablement === "" || ["0", "false", "no"].includes(rawEnablement)
      ? "disabled"
      : "invalid";

  try {
    const contracts = configuredJiandaoyunContracts(env);
    return {
      enablementState,
      contractSelectionState: contracts.length > 0 ? "selected" : "missing",
      selectedContractCount: contracts.length,
    };
  } catch {
    return {
      enablementState,
      contractSelectionState: "invalid",
      selectedContractCount: 0,
    };
  }
}

function yonyouActivation(env: NodeJS.ProcessEnv): ConnectorActivation {
  const rawEnablement = env.YY_SYNC_ENABLED?.trim().toLowerCase() ?? "";
  const enablementState: ConnectorEnablementState = yonyouSyncEnabled(env)
    ? "enabled"
    : rawEnablement === "" || ["0", "false", "no"].includes(rawEnablement)
      ? "disabled"
      : "invalid";
  const rawContracts = env.YY_APPROVED_API_CONTRACTS?.trim() ?? "";
  const contracts = parseYonyouApprovedApiContracts(rawContracts);
  return {
    enablementState,
    contractSelectionState: contracts
      ? "selected"
      : rawContracts
        ? "invalid"
        : "missing",
    selectedContractCount: contracts?.length ?? 0,
  };
}

function connectorActivation(connector: Connector, env: NodeJS.ProcessEnv): ConnectorActivation {
  if (connector.key === "jdy") return jiandaoyunActivation(env);
  if (connector.key === "yy") return yonyouActivation(env);
  return {
    enablementState: "not_required",
    contractSelectionState: "not_required",
    selectedContractCount: 0,
  };
}

/** Strict RFC3339-style instant parser; rejects Date.parse normalization and impossible dates. */
function parseIsoInstant(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = ISO_INSTANT_PATTERN.exec(raw);
  if (!match) return null;
  const [
    ,
    yearRaw,
    monthRaw,
    dayRaw,
    hourRaw,
    minuteRaw,
    secondRaw,
    fractionRaw,
    zoneRaw,
    ,
    offsetHourRaw,
    offsetMinuteRaw,
  ] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number((fractionRaw ?? "").padEnd(3, "0"));
  const offsetHour = Number(offsetHourRaw ?? "0");
  const offsetMinute = Number(offsetMinuteRaw ?? "0");
  if (
    month < 1
    || month > 12
    || day < 1
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
  ) return null;

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, millisecond);
  if (
    wallClock.getUTCFullYear() !== year
    || wallClock.getUTCMonth() !== month - 1
    || wallClock.getUTCDate() !== day
    || wallClock.getUTCHours() !== hour
    || wallClock.getUTCMinutes() !== minute
    || wallClock.getUTCSeconds() !== second
    || wallClock.getUTCMilliseconds() !== millisecond
  ) return null;

  const instant = Date.parse(raw);
  return Number.isFinite(instant) && zoneRaw ? instant : null;
}

function liveVerification(
  timestampKey: string | undefined,
  evidenceRefKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): {
  state: LiveVerificationState;
  verifiedAt: string | null;
  evidenceRef: string | null;
} {
  if (!timestampKey || !evidenceRefKey) {
    return { state: "missing", verifiedAt: null, evidenceRef: null };
  }
  const timestamp = env[timestampKey]?.trim();
  const rawEvidenceRef = env[evidenceRefKey]?.trim();
  if (!timestamp && !rawEvidenceRef) {
    return { state: "missing", verifiedAt: null, evidenceRef: null };
  }
  const evidenceRef = rawEvidenceRef
    && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(rawEvidenceRef)
    ? rawEvidenceRef
    : null;
  const instant = parseIsoInstant(timestamp);
  if (instant === null || (!evidenceRef && rawEvidenceRef)) {
    return { state: "invalid", verifiedAt: null, evidenceRef };
  }
  const verifiedAt = new Date(instant).toISOString();
  if (instant > now.getTime()) {
    return { state: "future", verifiedAt, evidenceRef };
  }
  if (now.getTime() - instant > LIVE_VERIFICATION_MAX_AGE_MS) {
    return { state: "stale", verifiedAt, evidenceRef };
  }
  if (!evidenceRef) {
    return { state: "missing_evidence", verifiedAt, evidenceRef: null };
  }
  return { state: "valid", verifiedAt, evidenceRef };
}

/** Reuses the connector's strict timestamp/evidence policy without requiring a target chat ID. */
export function feishuAppLiveVerification(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
) {
  return liveVerification(
    "FEISHU_APP_LIVE_VERIFIED_AT",
    "FEISHU_APP_LIVE_VERIFIED_REF",
    env,
    now,
  );
}

/** Strict, dated evidence that the current Feishu app passed least-privilege review. */
export function feishuAppPermissionReviewVerification(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
) {
  return liveVerification(
    "FEISHU_APP_PERMISSION_REVIEWED_AT",
    "FEISHU_APP_PERMISSION_REVIEWED_REF",
    env,
    now,
  );
}

/**
 * Operational registry, not a success checklist:
 * - ready means transport/validation code exists;
 * - configured means one complete machine-auth path is present;
 * - enabled and contract selection are separate business-flow gates, not credential state;
 * - operational additionally requires every applicable gate plus a dated live-UAT marker and
 *   never treats credentials or a human UI login as proof that the business flow works.
 */
export const CONNECTORS: Connector[] = [
  {
    key: "jst",
    label: "聚水潭（出库销量/库存）",
    implementation: "ready",
    auth: "signed_token",
    systemOfRecord: "电商订单、实际出库销量、平台/WMS 库存观察",
    capabilities: [
      "outbound-sales-daily",
      "inventory-total-delta-staging",
      "shop-discovery-client",
      "warehouse-discovery-client",
      "batch-allocation-evidence",
    ],
    requiredEnv: ["JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN", "JST_SYNC_ACTOR_ID"],
    optionalEnv: [
      "JST_BASE_URL",
      "JST_INVENTORY_SYNC_ENABLED",
      "JST_LIVE_VERIFIED_AT",
      "JST_LIVE_VERIFIED_REF",
    ],
    liveVerificationEnv: "JST_LIVE_VERIFIED_AT",
    liveVerificationRefEnv: "JST_LIVE_VERIFIED_REF",
    sourceDocs: [
      "https://openweb.jushuitan.com/doc?docId=20",
      "https://openweb.jushuitan.com/doc?docId=23",
      "https://openweb.jushuitan.com/doc?docId=30",
      "https://openweb.jushuitan.com/doc?docId=70",
      "https://openweb.jushuitan.com/dev-doc",
      "https://openweb.jushuitan.com/dev-doc?docType=8&docId=34",
      "https://openweb.jushuitan.com/dev-doc?docType=3&docId=15",
      "https://openweb.jushuitan.com/dev-doc?docType=1&docId=3",
    ],
    blocker: "日出库与库存总量增量均进入受控 staging；需开放平台 app/token、IP 白名单、接口权限、责任人 ID，并在真实对账/UAT 后设置时间与非秘密证据编号",
    isConfigured(env = process.env) {
      const actor = Number(env.JST_SYNC_ACTOR_ID);
      try {
        return jstConfigFromEnv(env) !== null && Number.isInteger(actor) && actor > 0;
      } catch {
        return false;
      }
    },
    missingEnv(env = process.env) {
      const result = missing(["JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN"], env);
      if (env.JST_BASE_URL?.trim() && !normalizeJstBaseUrl(env.JST_BASE_URL)) {
        result.push("JST_BASE_URL");
      }
      const actor = Number(env.JST_SYNC_ACTOR_ID);
      if (!Number.isInteger(actor) || actor <= 0) result.push("JST_SYNC_ACTOR_ID");
      return result;
    },
  },
  {
    key: "jdy",
    label: "简道云（现行低代码 ERP 观察层）",
    implementation: "ready",
    auth: "api_key",
    systemOfRecord: "现行简道云应用、表单与受控业务观察；SCM 主档/单据/库存账仍须人工放行",
    capabilities: [
      "application-form-catalog",
      "field-minimized-form-observations",
      "schema-drift-guard",
      "immutable-evidence-and-staging",
    ],
    requiredEnv: ["JIANDAOYUN_API_KEY", "JIANDAOYUN_SYNC_ACTOR_ID"],
    optionalEnv: [
      "JIANDAOYUN_BASE_URL",
      "JIANDAOYUN_SYNC_ENABLED",
      "JIANDAOYUN_SYNC_CONTRACTS",
      "JIANDAOYUN_LIVE_VERIFIED_AT",
      "JIANDAOYUN_LIVE_VERIFIED_REF",
    ],
    liveVerificationEnv: "JIANDAOYUN_LIVE_VERIFIED_AT",
    liveVerificationRefEnv: "JIANDAOYUN_LIVE_VERIFIED_REF",
    sourceDocs: [
      "https://hc.jiandaoyun.com/open/10992",
      "https://hc.jiandaoyun.com/open/18538",
      "https://hc.jiandaoyun.com/open/18539",
      "https://hc.jiandaoyun.com/open/14216",
      "https://hc.jiandaoyun.com/open/14220",
    ],
    blocker: "目录与九条最小化观察契约已就绪；数据只进入 evidence/staging。需轮换已在聊天暴露的密钥、配置责任人和显式表单契约，并完成控制总量/重复视图/UAT 后记录时间与非秘密证据编号",
    isConfigured(env = process.env) {
      try {
        return jiandaoyunConfigFromEnv(env) !== null && jiandaoyunSyncActorId(env) !== null;
      } catch {
        return false;
      }
    },
    missingEnv(env = process.env) {
      const result = missing(["JIANDAOYUN_API_KEY"], env);
      if (
        env.JIANDAOYUN_BASE_URL?.trim()
        && !normalizeJiandaoyunBaseUrl(env.JIANDAOYUN_BASE_URL)
      ) result.push("JIANDAOYUN_BASE_URL");
      if (jiandaoyunSyncActorId(env) === null) result.push("JIANDAOYUN_SYNC_ACTOR_ID");
      return result;
    },
  },
  {
    key: "yy",
    label: "用友（财务/成本）",
    // 2026-08-03：yonyou-client.ts 补齐 token 客户端与契约白名单调用层（tests/integrations/
    // yonyou-client.test.ts 用假 transport 跑完整路径），此前只有配置校验故为 contract_only。
    implementation: "ready",
    auth: "oauth_app",
    systemOfRecord: "财务凭证、成本、结算与组织核算口径",
    capabilities: ["cost-authority", "settlement-posting", "financial-reconciliation"],
    requiredEnv: [...YONYOU_REQUIRED_ENV],
    optionalEnv: [
      "YY_CLIENT_ID",
      "YY_CLIENT_SECRET",
      "YY_SYNC_ENABLED",
      "YY_LIVE_VERIFIED_AT",
      "YY_LIVE_VERIFIED_REF",
    ],
    liveVerificationEnv: "YY_LIVE_VERIFIED_AT",
    liveVerificationRefEnv: "YY_LIVE_VERIFIED_REF",
    sourceDocs: ["https://developer.yonyou.com/openAPI"],
    blocker: "网关与鉴权已实测打通（c4/iuap-api-gateway，token 正常）；八条只读契约在控制台逐条授权前全部返回 310037，仍缺企业 API 授权与租户/目标组织（授权后组织架构接口可直接读出）",
    isConfigured(env = process.env) {
      return yonyouConfigFromEnv(env) !== null;
    },
    missingEnv(env = process.env) {
      return yonyouMissingEnv(env);
    },
  },
  {
    key: "feishu",
    label: "飞书（协同通知）",
    implementation: "ready",
    auth: "webhook_or_app",
    systemOfRecord: "协同触达（SCM 通知发件箱仍是发送状态权威）",
    capabilities: ["group-webhook", "app-bot-message", "deduplicated-delivery"],
    requiredEnv: [],
    optionalEnv: [
      "FEISHU_WEBHOOK_URL",
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "FEISHU_CHAT_ID",
      "FEISHU_APP_LIVE_VERIFIED_AT",
      "FEISHU_APP_LIVE_VERIFIED_REF",
      "FEISHU_APP_PERMISSION_REVIEWED_AT",
      "FEISHU_APP_PERMISSION_REVIEWED_REF",
      "FEISHU_WEBHOOK_LIVE_VERIFIED_AT",
      "FEISHU_WEBHOOK_LIVE_VERIFIED_REF",
    ],
    sourceDocs: [
      "https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal",
      "https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/application/get",
      "https://open.feishu.cn/document/server-docs/im-v1/message/create",
    ],
    blocker: "配置自定义 webhook，或配置应用 app_id/app_secret/chat_id；完成真实群投递/UAT 后记录时间与非秘密证据编号",
    isConfigured(env = process.env) {
      return feishuWebhookUrlFromEnv(env) !== null || feishuAppConfigFromEnv(env) !== null;
    },
    missingEnv(env = process.env) {
      return feishuMissing(env);
    },
  },
];

export function configuredConnectors(env: NodeJS.ProcessEnv = process.env): Connector[] {
  return CONNECTORS.filter(
    (connector) => connector.implementation === "ready" && connector.isConfigured(env),
  );
}

export interface ConnectorReadiness {
  key: string;
  label: string;
  implementation: ConnectorImplementation;
  configured: boolean;
  enablementState: ConnectorEnablementState;
  contractSelectionState: ConnectorContractSelectionState;
  selectedContractCount: number;
  /** Code/configuration/enablement/contract/UAT gates only; it is not live runtime health. */
  configurationReady: boolean;
  operational: boolean;
  auth: ConnectorAuth;
  systemOfRecord: string;
  capabilities: string[];
  /** Capabilities that the currently configured authentication path can actually exercise. */
  effectiveCapabilities: string[];
  configuredAuthPaths: string[];
  activeAuthPath: string | null;
  identityScope: ConnectorIdentityScope | null;
  identityClearanceState: IdentityClearanceState;
  openScopedAliasExceptions: number | null;
  observedScopedIdentities: number | null;
  requiredEnv: string[];
  optionalEnv: string[];
  missingEnv: string[];
  liveVerifiedAt: string | null;
  liveVerificationRef: string | null;
  liveVerificationState: LiveVerificationState;
  liveVerificationMaxAgeDays: number;
  expectedLiveVerificationBinding: string | null;
  securityReviewState: ConnectorSecurityReviewState;
  securityReviewedAt: string | null;
  securityReviewRef: string | null;
  expectedSecurityReviewBinding: string | null;
  securityReviewMaxAgeDays: number;
  blocker: string | null;
}

const IDENTITY_SCOPE_BY_CONNECTOR: Readonly<Partial<Record<Connector["key"], ConnectorIdentityScope>>> = {
  jst: "JST",
  jdy: "JIANDAOYUN",
  yy: "YONYOU",
};

function configuredAuthPaths(connector: Connector, env: NodeJS.ProcessEnv): string[] {
  if (connector.key !== "feishu") return connector.isConfigured(env) ? [connector.auth] : [];
  const paths: string[] = [];
  try {
    if (feishuWebhookUrlFromEnv(env)) paths.push("webhook");
  } catch {
    // Invalid look-alike URLs are reported by missingEnv; they are not an authentication path.
  }
  try {
    if (feishuAppConfigFromEnv(env)) paths.push("app_bot");
  } catch {
    // Partial/invalid app configuration is not an authentication path.
  }
  return paths;
}

function activeAuthPath(connector: Connector, authPaths: readonly string[]): string | null {
  if (authPaths.length === 0) return null;
  if (connector.key === "feishu") {
    // notify.ts intentionally prefers the application bot whenever it is fully configured.
    return authPaths.includes("app_bot") ? "app_bot" : "webhook";
  }
  return authPaths[0] ?? null;
}

function effectiveCapabilities(
  connector: Connector,
  activePath: string | null,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!activePath) return [];
  if (connector.key === "feishu") {
    // Only the app API accepts the stable UUID used by notify.ts. Webhook delivery is at-least-once.
    return activePath === "app_bot"
      ? ["app-bot-message", "deduplicated-delivery"]
      : ["group-webhook"];
  }
  if (connector.key === "jst" && !jstInventorySyncEnabled(env)) {
    return connector.capabilities.filter((capability) =>
      capability !== "inventory-total-delta-staging");
  }
  return [...connector.capabilities];
}

function liveVerificationKeys(
  connector: Connector,
  selectedPath: string | null,
): { timestampKey: string | undefined; evidenceRefKey: string | undefined } {
  if (connector.key !== "feishu" || selectedPath === null) {
    return {
      timestampKey: connector.liveVerificationEnv,
      evidenceRefKey: connector.liveVerificationRefEnv,
    };
  }
  return selectedPath === "app_bot"
    ? {
        timestampKey: "FEISHU_APP_LIVE_VERIFIED_AT",
        evidenceRefKey: "FEISHU_APP_LIVE_VERIFIED_REF",
      }
    : {
        timestampKey: "FEISHU_WEBHOOK_LIVE_VERIFIED_AT",
        evidenceRefKey: "FEISHU_WEBHOOK_LIVE_VERIFIED_REF",
      };
}

export function getConnectorReadiness(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  identityEvidence?: Readonly<Partial<Record<ConnectorIdentityScope, ConnectorIdentityEvidence>>>,
  runtimeEvidence?: Readonly<ConnectorRuntimeEvidence>,
): ConnectorReadiness[] {
  return CONNECTORS.map((connector) => {
    const configured = connector.isConfigured(env);
    const activation = connectorActivation(connector, env);
    const authPaths = configuredAuthPaths(connector, env);
    const selectedAuthPath = activeAuthPath(connector, authPaths);
    const verificationKeys = liveVerificationKeys(connector, selectedAuthPath);
    let verification = liveVerification(
      verificationKeys.timestampKey,
      verificationKeys.evidenceRefKey,
      env,
      now,
    );
    let expectedLiveVerificationBinding: string | null = null;
    let securityReview: {
      state: ConnectorSecurityReviewState;
      verifiedAt: string | null;
      evidenceRef: string | null;
    } = { state: "not_required", verifiedAt: null, evidenceRef: null };
    let expectedSecurityReviewBinding: string | null = null;
    const partialFeishuApp = connector.key === "feishu"
      ? feishuAppCredentialsFromEnv(env)
      : null;
    const suppliedFeishuPermission = runtimeEvidence?.feishuPermission ?? null;
    const currentFeishuPermission = connector.key === "feishu"
      && partialFeishuApp
      && suppliedFeishuPermission?.appId === partialFeishuApp.appId
      ? suppliedFeishuPermission
      : null;
    if (
      connector.key === "feishu"
      && (selectedAuthPath === "app_bot" || (selectedAuthPath === null && partialFeishuApp))
      && partialFeishuApp
    ) {
      securityReview = feishuAppPermissionReviewVerification(env, now);
      if (currentFeishuPermission?.fingerprint) {
        expectedSecurityReviewBinding = feishuPermissionReviewEvidenceBinding(
          partialFeishuApp.appId,
          currentFeishuPermission.fingerprint,
        );
      }
      if (
        securityReview.state === "valid"
        && (
          currentFeishuPermission?.leastPrivilege !== "no_excess_detected"
          || !currentFeishuPermission.fingerprint
          || !feishuEvidenceRefHasPermissionReviewBinding(
            securityReview.evidenceRef,
            partialFeishuApp.appId,
            currentFeishuPermission.fingerprint,
          )
        )
      ) securityReview = { ...securityReview, state: "unbound" };
    }
    if (
      connector.key === "feishu"
      && selectedAuthPath === "app_bot"
    ) {
      const appConfig = feishuAppConfigFromEnv(env);
      if (appConfig) {
        expectedLiveVerificationBinding = feishuTargetEvidenceBinding(
          appConfig.appId,
          appConfig.chatId,
        );
      }
      if (
        verification.state === "valid"
        && (!appConfig || !feishuEvidenceRefHasTargetBinding(
          verification.evidenceRef,
          appConfig.appId,
          appConfig.chatId,
        ))
      ) verification = { ...verification, state: "unbound" };
    } else if (
      connector.key === "jst"
    ) {
      expectedLiveVerificationBinding = jstLiveEvidenceBinding(env);
      if (
        verification.state === "valid"
        && !jstEvidenceRefHasLiveBinding(verification.evidenceRef, env)
      ) verification = { ...verification, state: "unbound" };
    } else if (
      connector.key === "jdy"
      && activation.contractSelectionState === "selected"
    ) {
      const contracts = configuredJiandaoyunContracts(env);
      expectedLiveVerificationBinding = jiandaoyunContractSetEvidenceBinding(contracts);
      if (
        verification.state === "valid"
        && !jiandaoyunEvidenceRefHasContractSetBinding(verification.evidenceRef, contracts)
      ) verification = { ...verification, state: "unbound" };
    } else if (
      connector.key === "yy"
      && activation.contractSelectionState === "selected"
    ) {
      expectedLiveVerificationBinding = yonyouLiveEvidenceBinding(env);
      if (
        verification.state === "valid"
        && !yonyouEvidenceRefHasLiveBinding(verification.evidenceRef, env)
      ) verification = { ...verification, state: "unbound" };
    }
    const identityScope = IDENTITY_SCOPE_BY_CONNECTOR[connector.key] ?? null;
    const scopeEvidence = identityScope ? identityEvidence?.[identityScope] : undefined;
    const openScopedAliasExceptions = scopeEvidence
      ? Math.max(0, Math.trunc(scopeEvidence.openExceptions))
      : null;
    const observedScopedIdentities = scopeEvidence
      ? Math.max(0, Math.trunc(scopeEvidence.observedIdentities))
      : null;
    const identityClearanceState: IdentityClearanceState = !identityScope
      ? "not_required"
      : openScopedAliasExceptions === null || observedScopedIdentities === null
        ? "unknown"
      : openScopedAliasExceptions > 0
          ? "blocked"
          : observedScopedIdentities > 0
            ? "clear"
            : "unknown";
    const configurationReady =
      connector.implementation === "ready"
      && configured
      && ["not_required", "enabled"].includes(activation.enablementState)
      && ["not_required", "selected"].includes(activation.contractSelectionState)
      && verification.state === "valid"
      && ["not_required", "valid"].includes(securityReview.state);
    const identityBlocker = identityClearanceState === "blocked"
      ? `身份映射待裁决 ${openScopedAliasExceptions} 项；清零前不得标记 operational`
      : identityClearanceState === "unknown"
        ? "尚无作用域身份观察证据；不得标记 operational"
        : null;
    const verificationBindingBlocker = verification.state !== "unbound"
      ? null
      : connector.key === "jst"
        ? "Live UAT 证据未绑定当前聚水潭应用和启用能力；换应用或启用库存流后必须重新验收"
        : connector.key === "jdy"
        ? "Live UAT 证据未绑定当前简道云契约集；契约新增或移除后必须重新验收"
        : connector.key === "yy"
          ? "Live UAT 证据未绑定当前用友应用、租户/组织、产品、契约与端点；范围变更后必须重新验收"
        : connector.key === "feishu"
          ? "Live UAT 证据未绑定当前飞书应用和目标群；换应用或换群后必须重新验收"
          : null;
    const feishuPermissionBlocker = !partialFeishuApp
      || (selectedAuthPath !== "app_bot" && selectedAuthPath !== null)
      ? null
      : !currentFeishuPermission
        ? "缺少同次只读探针的当前飞书权限清单；静态配置不得标记生产就绪"
        : !currentFeishuPermission.fingerprint
          ? "当前飞书权限清单无法规范化并生成指纹；不得沿用旧复核证据"
          : currentFeishuPermission.leastPrivilege === "extreme_over_privilege"
            ? "当前飞书权限远超 SCM 通知最小集合；停止生产接入并重新授权复核"
            : currentFeishuPermission.leastPrivilege === "review_required"
              ? "当前飞书权限含通知白名单外项目；逐项复核前不得标记生产就绪"
              : currentFeishuPermission.leastPrivilege === "unknown"
                ? "当前飞书最小权限状态未知；不得标记生产就绪"
                : null;
    const securityReviewBlocker = securityReview.state === "not_required"
      ? null
      : securityReview.state === "valid"
        ? null
        : securityReview.state === "unbound"
          ? "飞书最小权限复核证据未绑定当前应用及当前权限清单；权限变化后必须重新复核"
          : "飞书应用缺少当前且有效的最小权限复核证据；未复核前不得标记生产就绪";
    return {
      key: connector.key,
      label: connector.label,
      implementation: connector.implementation,
      configured,
      enablementState: activation.enablementState,
      contractSelectionState: activation.contractSelectionState,
      selectedContractCount: activation.selectedContractCount,
      configurationReady,
      operational:
        configurationReady
        && ["not_required", "clear"].includes(identityClearanceState),
      auth: connector.auth,
      systemOfRecord: connector.systemOfRecord,
      capabilities: [...connector.capabilities],
      effectiveCapabilities: effectiveCapabilities(connector, selectedAuthPath, env),
      configuredAuthPaths: authPaths,
      activeAuthPath: selectedAuthPath,
      identityScope,
      identityClearanceState,
      openScopedAliasExceptions,
      observedScopedIdentities,
      requiredEnv: [...connector.requiredEnv],
      optionalEnv: [...connector.optionalEnv],
      missingEnv: connector.missingEnv(env),
      liveVerifiedAt: verification.verifiedAt,
      liveVerificationRef: verification.evidenceRef,
      liveVerificationState: verification.state,
      liveVerificationMaxAgeDays: LIVE_VERIFICATION_MAX_AGE_DAYS,
      expectedLiveVerificationBinding,
      securityReviewState: securityReview.state,
      securityReviewedAt: securityReview.verifiedAt,
      securityReviewRef: securityReview.evidenceRef,
      expectedSecurityReviewBinding,
      securityReviewMaxAgeDays: LIVE_VERIFICATION_MAX_AGE_DAYS,
      blocker: [
        connector.blocker,
        verificationBindingBlocker,
        feishuPermissionBlocker,
        securityReviewBlocker,
        identityBlocker,
      ].filter(Boolean).join("；") || null,
    };
  });
}
