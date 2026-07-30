import { feishuAppConfigFromEnv } from "./feishu";
import {
  jiandaoyunConfigFromEnv,
  jiandaoyunSyncActorId,
} from "./jiandaoyun";
import { jstConfigFromEnv } from "./jst";
import {
  YONYOU_REQUIRED_ENV,
  yonyouConfigFromEnv,
  yonyouMissingEnv,
} from "./yonyou";

export type ConnectorImplementation = "ready" | "contract_only";
export type ConnectorAuth = "signed_token" | "api_key" | "oauth_app" | "webhook_or_app";

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
  sourceDocs: string[];
  blocker?: string;
  isConfigured(env?: NodeJS.ProcessEnv): boolean;
  missingEnv(env?: NodeJS.ProcessEnv): string[];
}

function missing(keys: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return keys.filter((key) => !env[key]?.trim());
}

function feishuMissing(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.FEISHU_WEBHOOK_URL?.trim()) return [];
  const appPath = missing(["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID"], env);
  return appPath.length === 0 ? [] : appPath;
}

function liveVerifiedAt(
  key: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!key) return null;
  const value = env[key]?.trim();
  if (!value) return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || instant > Date.now()) return null;
  return new Date(instant).toISOString();
}

/**
 * Operational registry, not a success checklist:
 * - ready means transport/validation code exists;
 * - configured means one complete machine-auth path is present;
 * - operational additionally requires a dated live-UAT marker and never treats credentials or a
 *   human UI login as proof that the business flow works.
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
      "warehouse-discovery-client",
      "batch-allocation-evidence",
    ],
    requiredEnv: ["JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN", "JST_SYNC_ACTOR_ID"],
    optionalEnv: ["JST_BASE_URL", "JST_INVENTORY_SYNC_ENABLED", "JST_LIVE_VERIFIED_AT"],
    liveVerificationEnv: "JST_LIVE_VERIFIED_AT",
    sourceDocs: [
      "https://openweb.jushuitan.com/doc?docId=20",
      "https://openweb.jushuitan.com/doc?docId=30",
      "https://openweb.jushuitan.com/doc?docId=70",
      "https://openweb.jushuitan.com/dev-doc?docType=8&docId=34",
      "https://openweb.jushuitan.com/dev-doc?docType=3&docId=15",
      "https://openweb.jushuitan.com/dev-doc?docType=1&docId=3",
    ],
    blocker: "日出库与库存总量增量均进入受控 staging；需开放平台 app/token、IP 白名单、接口权限、责任人 ID，并在真实对账/UAT 后设置 JST_LIVE_VERIFIED_AT",
    isConfigured(env = process.env) {
      const actor = Number(env.JST_SYNC_ACTOR_ID);
      return jstConfigFromEnv(env) !== null && Number.isInteger(actor) && actor > 0;
    },
    missingEnv(env = process.env) {
      const result = missing(["JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN"], env);
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
    ],
    liveVerificationEnv: "JIANDAOYUN_LIVE_VERIFIED_AT",
    sourceDocs: [
      "https://hc.jiandaoyun.com/open/10992",
      "https://hc.jiandaoyun.com/open/18538",
      "https://hc.jiandaoyun.com/open/18539",
      "https://hc.jiandaoyun.com/open/14216",
      "https://hc.jiandaoyun.com/open/14220",
    ],
    blocker: "目录与九条最小化观察契约已就绪；数据只进入 evidence/staging。需轮换已在聊天暴露的密钥、配置责任人和显式表单契约，并完成控制总量/重复视图/UAT 后再设置 JIANDAOYUN_LIVE_VERIFIED_AT",
    isConfigured(env = process.env) {
      try {
        return jiandaoyunConfigFromEnv(env) !== null && jiandaoyunSyncActorId(env) !== null;
      } catch {
        return false;
      }
    },
    missingEnv(env = process.env) {
      const result = missing(["JIANDAOYUN_API_KEY"], env);
      const baseUrl = env.JIANDAOYUN_BASE_URL?.trim();
      if (baseUrl && !/^https:\/\//i.test(baseUrl)) result.push("JIANDAOYUN_BASE_URL");
      if (jiandaoyunSyncActorId(env) === null) result.push("JIANDAOYUN_SYNC_ACTOR_ID");
      return result;
    },
  },
  {
    key: "yy",
    label: "用友（财务/成本）",
    implementation: "contract_only",
    auth: "oauth_app",
    systemOfRecord: "财务凭证、成本、结算与组织核算口径",
    capabilities: ["cost-authority", "settlement-posting", "financial-reconciliation"],
    requiredEnv: [...YONYOU_REQUIRED_ENV],
    optionalEnv: ["YY_CLIENT_ID", "YY_CLIENT_SECRET"],
    sourceDocs: ["https://developer.yonyou.com/openAPI"],
    blocker: "C4 人工账号和 AppKey/AppSecret 对都不能单独证明可调用；待注册并授权企业应用、确认产品、租户/组织、公开 HTTPS 端点与获批接口，先完成沙箱只读对账",
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
      "FEISHU_LIVE_VERIFIED_AT",
    ],
    liveVerificationEnv: "FEISHU_LIVE_VERIFIED_AT",
    sourceDocs: [
      "https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal",
      "https://open.feishu.cn/document/server-docs/im-v1/message/create",
    ],
    blocker: "配置自定义 webhook，或配置应用 app_id/app_secret/chat_id；完成真实群投递/UAT 后设置 FEISHU_LIVE_VERIFIED_AT",
    isConfigured(env = process.env) {
      return Boolean(env.FEISHU_WEBHOOK_URL?.trim()) || feishuAppConfigFromEnv(env) !== null;
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
  operational: boolean;
  auth: ConnectorAuth;
  systemOfRecord: string;
  capabilities: string[];
  requiredEnv: string[];
  optionalEnv: string[];
  missingEnv: string[];
  liveVerifiedAt: string | null;
  blocker: string | null;
}

export function getConnectorReadiness(env: NodeJS.ProcessEnv = process.env): ConnectorReadiness[] {
  return CONNECTORS.map((connector) => {
    const configured = connector.isConfigured(env);
    const verifiedAt = liveVerifiedAt(connector.liveVerificationEnv, env);
    return {
      key: connector.key,
      label: connector.label,
      implementation: connector.implementation,
      configured,
      operational: connector.implementation === "ready" && configured && verifiedAt !== null,
      auth: connector.auth,
      systemOfRecord: connector.systemOfRecord,
      capabilities: [...connector.capabilities],
      requiredEnv: [...connector.requiredEnv],
      optionalEnv: [...connector.optionalEnv],
      missingEnv: connector.missingEnv(env),
      liveVerifiedAt: verifiedAt,
      blocker: connector.blocker ?? null,
    };
  });
}
