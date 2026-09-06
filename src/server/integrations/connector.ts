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
import { configuredJstGovernedObservationContracts } from "./jst-observation-sync";
import {
  YONYOU_REQUIRED_ENV,
  parseYonyouApprovedApiContracts,
  yonyouConfigFromEnv,
  yonyouEvidenceRefHasLiveBinding,
  yonyouLiveEvidenceBinding,
  yonyouMissingEnv,
  yonyouSyncEnabled,
} from "./yonyou";
import { YONYOU_READ_CONTRACTS } from "./yonyou-contracts";

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
      "item-master-observation-staging",
      "inbound-receipts-observation-staging",
      "shop-discovery-client",
      "warehouse-discovery-client",
      "batch-allocation-evidence",
    ],
    requiredEnv: ["JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN", "JST_SYNC_ACTOR_ID"],
    optionalEnv: [
      "JST_BASE_URL",
      "JST_INVENTORY_SYNC_ENABLED",
      "JST_OBSERVATION_SYNC_CONTRACTS",
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
      "https://open.jushuitan.com/document/2167.html",
      "https://open.jushuitan.com/document/2019.html",
      "https://open.jushuitan.com/document/2125.html",
      "https://open.jushuitan.com/document/15.html",
      "https://open.jushuitan.com/document.aspx?doc_id=2352",
      "https://open.jushuitan.com/document.aspx?doc_id=2356",
    ],
    blocker: "日出库、库存增量、商品主档与采购入库均只进入受控 staging；需开放平台 app/token、IP 白名单、逐接口权限、显式读取契约选择与责任人 ID，并在真实对账/UAT 后设置时间与非秘密证据编号",
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
    blocker: "目录与显式观察契约读取已实现，数据只进入 evidence/staging；已选数量仅反映当前配置，不代表同步成功或 UAT 通过。实际结果须核对逐流运行记录，并完成身份认领、字段语义、控制总量与业务验收，再绑定当前契约集的时间和非秘密证据编号",
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
    label: "用友（财务/成本，只读观察）",
    // 2026-08-03：yonyou-client.ts 补齐 token 客户端与契约白名单调用层（tests/integrations/
    // yonyou-client.test.ts 用假 transport 跑完整路径），此前只有配置校验故为 contract_only。
    implementation: "ready",
    auth: "oauth_app",
    systemOfRecord: "用友持有财务凭证、成本与组织核算口径；本连接器只读观察，不回写凭证或结算",
    capabilities: [
      "read-only-contract-observations",
      "immutable-evidence-and-staging",
      "field-profile-without-values",
      "schema-drift-guard",
    ],
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
    blocker: "只读客户端与受控 staging 已实现，不创建或回写凭证、结算及库存账。当前授权和读取结果以带时间和范围的探针及运行记录为准；仍须核对企业 API 授权、租户/组织、字段映射、控制总量和业务 UAT，配置齐备或 token 获取成功不等于接通",
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
  /** Current configuration only; not the defined-contract count, a successful-run count or UAT proof. */
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
  /** 面向业务管理员的确定性解锁路径；不包含密钥、外部原值或未经验证的成功声明。 */
  remediationSteps: string[];
  /** 连接器官方管理入口；仅用于人工授权与核对。 */
  managementUrl: string | null;
}

const CONNECTOR_MANAGEMENT_URL: Readonly<Partial<Record<Connector["key"], string>>> = {
  jst: "https://open.jushuitan.com/",
  jdy: "https://www.jiandaoyun.com/",
  yy: "https://c4.yonyoucloud.com/",
  feishu: "https://open.feishu.cn/app",
};

function remediationSteps(
  connector: Connector,
  readiness: {
    configured: boolean;
    activation: ConnectorActivation;
    verification: LiveVerificationState;
    identity: IdentityClearanceState;
  },
): string[] {
  const steps: string[] = [];
  if (!readiness.configured) {
    steps.push("先补齐系统列出的缺失配置，再做任何外部读取；不得把网页可登录当成 API 已接通。");
  }
  if (readiness.activation.contractSelectionState === "missing") {
    steps.push("当前尚未选择同步契约；先由业务负责人批准所需的最小集合，并完成字段和权限评审。");
  } else if (readiness.activation.contractSelectionState === "invalid") {
    steps.push("当前契约选择无效；先修正为代码支持且业务已批准的最小集合，不自动扩大读取范围。");
  }
  if (connector.key === "jst") {
    steps.push(
      "核对固定出口 IP 白名单，以及应用、商家与 token 的授权范围。",
      "按业务批准范围核对店铺、仓库、销售出库、库存、普通商品、采购入库的只读权限；淘系/拼多多订单与售后需平台专用授权，不代表标准接口已覆盖全渠道。",
      "先做有界只读探针，再按已批准契约核对 staging；逐接口成功不等于全渠道接通，不直接写库存账或正式销售事实。",
      "完成 SKU/仓库精确映射、逐 SKU 控制总量、失败重放与连续 7 天恢复 UAT，最后绑定当前应用和启用能力的非秘密证据编号。",
    );
  } else if (connector.key === "yy") {
    steps.push(
      `代码白名单中的 ${YONYOU_READ_CONTRACTS.length} 项只读 API 仅代表实现范围；按当前产品、租户和组织逐项核对业务批准的 API 权限，不要求全选或全部授权。`,
      "先核对租户与组织，再按已选契约有界读取、评审无值字段画像；组织、供应商、物料按外部 ID 精确映射，禁止只按名称猜测。",
      "采购/库存控制总量由业务负责人核对，成本/凭证由财务复核；结构漂移或字段语义未评审时不放行，不回写凭证或结算。",
      "完成业务 UAT，再绑定当前应用、租户、组织、产品和已验收契约范围的非秘密证据编号；配置或 token 成功不代替验收。",
    );
  } else if (connector.key === "jdy") {
    steps.push(
      "核对应用/表单读取权限与已选契约范围，区分全量和滚动窗口；逐流查看运行结果，父任务失败不代表所有流停摆。",
      "处理平台 SKU、仓库和供应商身份队列，线索只供人工认领；缺失记录须回源核实，删除签认不绕过完整性守卫。",
      "按同截止日、同范围导出核对行数、数量、币种、冲销与净额；身份覆盖、控制总量、业务 UAT 和负责人会签齐备后才走受控放行，历史观察不冒充正式事实。",
    );
  } else {
    steps.push(
      "按当前应用或 webhook 路径核对 SCM 通知最小权限和目标群；不为验证通知扩大通讯录或业务数据权限。",
      "经负责人同意后做目标群投递与回读 UAT，并绑定当前路径的非秘密证据；网页登录或 token 获取不代替验收，送达不等于已读或业务处置完成。",
    );
  }
  if (readiness.activation.enablementState === "disabled") {
    steps.push("当前同步保持关闭；完成前述授权、核对和 UAT 后再显式启用，避免未验收数据进入持续任务。");
  } else if (readiness.activation.enablementState === "invalid") {
    steps.push("当前同步启用标记无效；由负责人核对配置，不自动改为开启。");
  }
  if (readiness.verification === "valid" && readiness.identity === "clear") {
    steps.push("持续监控时效、拒收、结构漂移和身份异常；任一门禁失效会自动降级。");
  }
  return steps;
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
  if (connector.key === "jst") {
    let observationContracts: string[] = [];
    try {
      observationContracts = configuredJstGovernedObservationContracts(env);
    } catch {
      observationContracts = [];
    }
    return connector.capabilities.filter((capability) => {
      if (capability === "inventory-total-delta-staging") return jstInventorySyncEnabled(env);
      if (capability === "item-master-observation-staging") {
        return observationContracts.includes("item-master");
      }
      if (capability === "inbound-receipts-observation-staging") {
        return observationContracts.includes("inbound-receipts-daily");
      }
      return true;
    });
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
    const operational = configurationReady
      && ["not_required", "clear"].includes(identityClearanceState);
    return {
      key: connector.key,
      label: connector.label,
      implementation: connector.implementation,
      configured,
      enablementState: activation.enablementState,
      contractSelectionState: activation.contractSelectionState,
      selectedContractCount: activation.selectedContractCount,
      configurationReady,
      operational,
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
      blocker: operational
        ? null
        : [
            connector.blocker,
            verificationBindingBlocker,
            feishuPermissionBlocker,
            securityReviewBlocker,
            identityBlocker,
          ].filter(Boolean).join("；") || null,
      remediationSteps: remediationSteps(connector, {
        configured,
        activation,
        verification: verification.state,
        identity: identityClearanceState,
      }),
      managementUrl: CONNECTOR_MANAGEMENT_URL[connector.key] ?? null,
    };
  });
}
