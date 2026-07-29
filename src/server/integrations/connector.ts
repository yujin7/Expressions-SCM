import { feishuAppConfigFromEnv } from "./feishu";
import { jstConfigFromEnv } from "./jst";
import { YONYOU_REQUIRED_ENV, yonyouConfigFromEnv } from "./yonyou";

export type ConnectorImplementation = "ready" | "contract_only";
export type ConnectorAuth = "signed_token" | "oauth_app" | "webhook_or_app";

export interface Connector {
  key: "jst" | "yy" | "feishu";
  label: string;
  implementation: ConnectorImplementation;
  auth: ConnectorAuth;
  systemOfRecord: string;
  capabilities: string[];
  requiredEnv: string[];
  optionalEnv: string[];
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

/**
 * Operational registry, not a success checklist:
 * - ready means transport/validation code exists;
 * - configured means one complete machine-auth path is present;
 * - operational requires both and never treats a human UI login as an API credential.
 */
export const CONNECTORS: Connector[] = [
  {
    key: "jst",
    label: "聚水潭（出库销量/库存）",
    implementation: "ready",
    auth: "signed_token",
    systemOfRecord: "电商订单、实际出库销量、平台/WMS 库存观察",
    capabilities: ["outbound-sales-daily", "inventory-observation"],
    requiredEnv: ["JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN", "JST_SYNC_ACTOR_ID"],
    optionalEnv: ["JST_BASE_URL"],
    sourceDocs: [
      "https://openweb.jushuitan.com/doc?docId=20",
      "https://openweb.jushuitan.com/doc?docId=30",
      "https://openweb.jushuitan.com/doc?docId=70",
    ],
    blocker: "代码与受控 staging 已就绪；需开放平台 app/token、IP 白名单、接口权限及系统同步责任人 ID",
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
    key: "yy",
    label: "用友（财务/成本）",
    implementation: "contract_only",
    auth: "oauth_app",
    systemOfRecord: "财务凭证、成本、结算与组织核算口径",
    capabilities: ["cost-authority", "settlement-posting", "financial-reconciliation"],
    requiredEnv: [...YONYOU_REQUIRED_ENV],
    optionalEnv: [],
    sourceDocs: ["https://developer.yonyou.com/openAPI"],
    blocker: "C4 人工账号不能替代 OpenAPI 应用；待创建并授权企业应用、确认租户/组织、token URL 与获批业务接口",
    isConfigured(env = process.env) {
      return yonyouConfigFromEnv(env) !== null;
    },
    missingEnv(env = process.env) {
      return missing(YONYOU_REQUIRED_ENV, env);
    },
  },
  {
    key: "feishu",
    label: "飞书（协同通知）",
    implementation: "ready",
    auth: "webhook_or_app",
    systemOfRecord: "协同触达（SCM 通知发件箱仍是发送状态权威）",
    capabilities: ["group-webhook", "app-bot-message", "deduplicated-delivery"],
    requiredEnv: ["FEISHU_WEBHOOK_URL"],
    optionalEnv: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID"],
    sourceDocs: [
      "https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal",
      "https://open.feishu.cn/document/server-docs/im-v1/message/create",
    ],
    blocker: "配置自定义 webhook，或配置应用 app_id/app_secret/chat_id；应用模式支持目标群与 UUID 去重",
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
  blocker: string | null;
}

export function getConnectorReadiness(env: NodeJS.ProcessEnv = process.env): ConnectorReadiness[] {
  return CONNECTORS.map((connector) => {
    const configured = connector.isConfigured(env);
    return {
      key: connector.key,
      label: connector.label,
      implementation: connector.implementation,
      configured,
      operational: connector.implementation === "ready" && configured,
      auth: connector.auth,
      systemOfRecord: connector.systemOfRecord,
      capabilities: [...connector.capabilities],
      requiredEnv: [...connector.requiredEnv],
      optionalEnv: [...connector.optionalEnv],
      missingEnv: connector.missingEnv(env),
      blocker: connector.blocker ?? null,
    };
  });
}
