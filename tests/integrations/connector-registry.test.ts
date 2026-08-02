import { afterEach, describe, expect, it } from "vitest";
import {
  configuredConnectors, CONNECTORS, getConnectorReadiness,
} from "@/server/integrations/connector";
import {
  feishuPermissionReviewEvidenceBinding,
  feishuPermissionSetFingerprint,
  feishuTargetEvidenceBinding,
} from "@/server/integrations/feishu";
import {
  jiandaoyunContract,
  jiandaoyunContractSetEvidenceBinding,
} from "@/server/integrations/jiandaoyun-contracts";

const envKeys = [
  "JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN", "JST_SYNC_ACTOR_ID", "JST_BASE_URL",
  "JST_INVENTORY_SYNC_ENABLED", "JST_LIVE_VERIFIED_AT", "JST_LIVE_VERIFIED_REF",
  "JIANDAOYUN_API_KEY", "JIANDAOYUN_SYNC_ACTOR_ID", "JIANDAOYUN_SYNC_ENABLED",
  "JIANDAOYUN_SYNC_CONTRACTS", "JIANDAOYUN_BASE_URL", "JIANDAOYUN_LIVE_VERIFIED_AT",
  "JIANDAOYUN_LIVE_VERIFIED_REF",
  "YY_APP_KEY", "YY_APP_SECRET",
  "YY_CLIENT_ID", "YY_CLIENT_SECRET", "YY_TENANT_ID", "YY_ORG_ID", "YY_BASE_URL", "YY_TOKEN_URL",
  "YY_PRODUCT_PROFILE", "YY_APPROVED_API_CONTRACTS",
  "YY_ALLOWED_HOSTS",
  "FEISHU_WEBHOOK_URL", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_CHAT_ID",
  "FEISHU_LIVE_VERIFIED_AT", "FEISHU_LIVE_VERIFIED_REF",
  "FEISHU_APP_LIVE_VERIFIED_AT", "FEISHU_APP_LIVE_VERIFIED_REF",
  "FEISHU_APP_PERMISSION_REVIEWED_AT", "FEISHU_APP_PERMISSION_REVIEWED_REF",
  "FEISHU_WEBHOOK_LIVE_VERIFIED_AT", "FEISHU_WEBHOOK_LIVE_VERIFIED_REF",
] as const;
const original = new Map(envKeys.map((key) => [key, process.env[key]]));
const NOW = new Date("2026-07-30T12:00:00Z");
const FEISHU_PERMISSION_FINGERPRINT = feishuPermissionSetFingerprint([
  { scope: "application:application:self_manage", level: 1 },
  { scope: "im:chat:readonly", level: 1 },
  { scope: "im:message:send_as_bot", level: 1 },
]);
const FEISHU_RUNTIME_EVIDENCE = {
  feishuPermission: {
    appId: "app",
    fingerprint: FEISHU_PERMISSION_FINGERPRINT,
    leastPrivilege: "no_excess_detected" as const,
  },
};

afterEach(() => {
  for (const key of envKeys) {
    const value = original.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("外部连接器目录", () => {
  it("登记真实目标系统；JST 凭据齐全只代表可运行，真实 UAT 后才可标 operational", () => {
    expect(CONNECTORS.map((connector) => connector.key)).toEqual(["jst", "jdy", "yy", "feishu"]);
    process.env.JST_APP_KEY = "present";
    process.env.JST_APP_SECRET = "present";
    process.env.JST_ACCESS_TOKEN = "present";
    process.env.JST_SYNC_ACTOR_ID = "3";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")).toMatchObject({
      implementation: "ready",
      configured: true,
      operational: false,
      auth: "signed_token",
      missingEnv: [],
      liveVerifiedAt: null,
      liveVerificationState: "missing",
      effectiveCapabilities: [
        "outbound-sales-daily",
        "warehouse-discovery-client",
        "batch-allocation-evidence",
      ],
    });
    expect(configuredConnectors().some((connector) => connector.key === "jst")).toBe(true);
    process.env.JST_BASE_URL = "https://openapi.jushuitan.com.evil.example";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")).toMatchObject({
      configured: false,
      operational: false,
      missingEnv: ["JST_BASE_URL"],
    });
    delete process.env.JST_BASE_URL;
    process.env.JST_LIVE_VERIFIED_AT = "2026-07-29T00:00:00Z";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")).toMatchObject({
      operational: false,
      liveVerifiedAt: "2026-07-29T00:00:00.000Z",
      liveVerificationState: "missing_evidence",
    });
    process.env.JST_LIVE_VERIFIED_REF = "UAT-20260729-JST-001";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")).toMatchObject({
      configurationReady: true,
      operational: false,
      identityClearanceState: "unknown",
      liveVerifiedAt: "2026-07-29T00:00:00.000Z",
      liveVerificationRef: "UAT-20260729-JST-001",
      liveVerificationState: "valid",
    });
    expect(getConnectorReadiness(process.env, NOW, {
      JST: { openExceptions: 0, observedIdentities: 1 },
    }).find((row) => row.key === "jst"))
      .toMatchObject({
        configurationReady: true,
        operational: true,
        identityScope: "JST",
        identityClearanceState: "clear",
        openScopedAliasExceptions: 0,
        observedScopedIdentities: 1,
      });
    expect(getConnectorReadiness(process.env, NOW, {
      JST: { openExceptions: 2, observedIdentities: 2 },
    }).find((row) => row.key === "jst"))
      .toMatchObject({
        configurationReady: true,
        operational: false,
        identityClearanceState: "blocked",
        openScopedAliasExceptions: 2,
      });
    expect(getConnectorReadiness(process.env, NOW, {}).find((row) => row.key === "jst"))
      .toMatchObject({
        operational: false,
        identityClearanceState: "unknown",
        openScopedAliasExceptions: null,
        observedScopedIdentities: null,
      });
    process.env.JST_INVENTORY_SYNC_ENABLED = "true";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jst")
      ?.effectiveCapabilities).toContain("inventory-total-delta-staging");
  });

  it("简道云把凭据、启用开关、契约选择和 UAT 分别判定", () => {
    process.env.JIANDAOYUN_API_KEY = "present";
    process.env.JIANDAOYUN_SYNC_ACTOR_ID = "3";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      implementation: "ready",
      configured: true,
      enablementState: "disabled",
      contractSelectionState: "missing",
      selectedContractCount: 0,
      operational: false,
      auth: "api_key",
      missingEnv: [],
      liveVerifiedAt: null,
    });
    expect(configuredConnectors().some((connector) => connector.key === "jdy")).toBe(true);
    process.env.JIANDAOYUN_LIVE_VERIFIED_AT = "2026-07-30T01:00:00Z";
    process.env.JIANDAOYUN_LIVE_VERIFIED_REF = "UAT-20260730-JDY-001";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      operational: false,
      liveVerifiedAt: "2026-07-30T01:00:00.000Z",
      liveVerificationState: "valid",
    });

    process.env.JIANDAOYUN_SYNC_ENABLED = "true";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      configured: true,
      enablementState: "enabled",
      contractSelectionState: "missing",
      operational: false,
    });

    process.env.JIANDAOYUN_SYNC_CONTRACTS = "unknown-contract";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      configured: true,
      enablementState: "enabled",
      contractSelectionState: "invalid",
      selectedContractCount: 0,
      operational: false,
    });

    process.env.JIANDAOYUN_SYNC_CONTRACTS =
      "product-master-observation,product-master-observation";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      configured: true,
      enablementState: "enabled",
      contractSelectionState: "selected",
      selectedContractCount: 1,
      configurationReady: false,
      operational: false,
      liveVerificationState: "unbound",
    });
    const productContract = jiandaoyunContract("product-master-observation");
    expect(productContract).not.toBeNull();
    const jdyBinding = jiandaoyunContractSetEvidenceBinding([productContract!]);
    expect(jiandaoyunContractSetEvidenceBinding([{
      ...productContract!,
      entryId: "changed-entry",
    }])).not.toBe(jdyBinding);
    process.env.JIANDAOYUN_LIVE_VERIFIED_REF = `UAT-20260730-JDY-${jdyBinding}`;
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      configurationReady: true,
      operational: false,
      identityClearanceState: "unknown",
      liveVerificationState: "valid",
      expectedLiveVerificationBinding: jdyBinding,
    });
    expect(getConnectorReadiness(process.env, NOW, {
      JIANDAOYUN: { openExceptions: 0, observedIdentities: 1 },
    }).find((row) => row.key === "jdy"))
      .toMatchObject({
        configurationReady: true,
        operational: true,
        identityClearanceState: "clear",
      });

    process.env.JIANDAOYUN_SYNC_CONTRACTS =
      "product-master-observation,supplier-observation";
    expect(getConnectorReadiness(process.env, NOW, {
      JIANDAOYUN: { openExceptions: 0, observedIdentities: 1 },
    }).find((row) => row.key === "jdy"))
      .toMatchObject({
        selectedContractCount: 2,
        configurationReady: false,
        operational: false,
        liveVerificationState: "unbound",
      });
    process.env.JIANDAOYUN_SYNC_CONTRACTS = "product-master-observation";

    process.env.JIANDAOYUN_SYNC_ENABLED = "sometimes";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      enablementState: "invalid",
      operational: false,
    });
    process.env.JIANDAOYUN_SYNC_ENABLED = "true";
    process.env.JIANDAOYUN_BASE_URL = "http://api.example.invalid";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "jdy")).toMatchObject({
      configured: false,
      operational: false,
      missingEnv: ["JIANDAOYUN_BASE_URL"],
    });
  });

  it("飞书 webhook 或应用机器人任一路径完整即可运行，但不伪装成已完成 live UAT", () => {
    process.env.FEISHU_WEBHOOK_URL =
      "https://open.feishu.cn/open-apis/bot/v2/hook/test-connector";
    expect(configuredConnectors().map((connector) => connector.key)).toContain("feishu");
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configured: true,
      operational: false,
      liveVerifiedAt: null,
      configuredAuthPaths: ["webhook"],
      activeAuthPath: "webhook",
      effectiveCapabilities: ["group-webhook"],
    });
    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-07-29T01:00:00Z";
    process.env.FEISHU_LIVE_VERIFIED_REF = "UAT-LEGACY-MUST-NOT-BIND";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      operational: false,
      liveVerifiedAt: null,
      liveVerificationState: "missing",
    });
    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "2026-07-29T01:00:00Z";
    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_REF = "UAT-20260729-FEISHU-WEBHOOK";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      operational: true,
      liveVerifiedAt: "2026-07-29T01:00:00.000Z",
      liveVerificationState: "valid",
    });
    process.env.FEISHU_WEBHOOK_URL = "https://attacker.example/webhook";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configured: false,
      operational: false,
      missingEnv: [
        "FEISHU_WEBHOOK_URL",
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
        "FEISHU_CHAT_ID",
      ],
    });
    delete process.env.FEISHU_WEBHOOK_URL;
    delete process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT;
    delete process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_REF;
    process.env.FEISHU_APP_ID = "app";
    process.env.FEISHU_APP_SECRET = "secret";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configured: false,
      activeAuthPath: null,
      securityReviewState: "missing",
      expectedSecurityReviewBinding: null,
    });
    process.env.FEISHU_CHAT_ID = "chat";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configured: true,
      operational: false,
      missingEnv: [],
      configuredAuthPaths: ["app_bot"],
      activeAuthPath: "app_bot",
      effectiveCapabilities: ["app-bot-message", "deduplicated-delivery"],
    });
    process.env.FEISHU_APP_LIVE_VERIFIED_AT = "2026-07-29T02:00:00Z";
    process.env.FEISHU_APP_LIVE_VERIFIED_REF = "UAT-20260729-FEISHU-APP";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configurationReady: false,
      operational: false,
      liveVerificationState: "unbound",
    });
    process.env.FEISHU_APP_LIVE_VERIFIED_REF =
      `UAT-20260729-${feishuTargetEvidenceBinding("app", "different-chat")}`;
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({
        configurationReady: false,
        operational: false,
        liveVerificationState: "unbound",
      });
    const boundRef = `UAT-20260729-${feishuTargetEvidenceBinding("app", "chat")}`;
    process.env.FEISHU_APP_LIVE_VERIFIED_REF = boundRef;
    expect(getConnectorReadiness(
      process.env,
      NOW,
      undefined,
      FEISHU_RUNTIME_EVIDENCE,
    ).find((row) => row.key === "feishu")).toMatchObject({
      configurationReady: false,
      operational: false,
      liveVerificationState: "valid",
      securityReviewState: "missing",
      expectedSecurityReviewBinding: feishuPermissionReviewEvidenceBinding(
        "app",
        FEISHU_PERMISSION_FINGERPRINT,
      ),
    });
    process.env.FEISHU_APP_PERMISSION_REVIEWED_AT = "2026-07-29T02:30:00Z";
    process.env.FEISHU_APP_PERMISSION_REVIEWED_REF =
      `SEC-20260729-${feishuPermissionReviewEvidenceBinding(
        "app",
        FEISHU_PERMISSION_FINGERPRINT,
      )}`;
    expect(getConnectorReadiness(
      process.env,
      NOW,
      undefined,
      FEISHU_RUNTIME_EVIDENCE,
    ).find((row) => row.key === "feishu")).toMatchObject({
      configurationReady: true,
      operational: true,
      liveVerificationState: "valid",
      liveVerificationRef: boundRef,
      securityReviewState: "valid",
    });
    const changedFingerprint = feishuPermissionSetFingerprint([
      { scope: "application:application:self_manage", level: 2 },
      { scope: "im:chat:readonly", level: 1 },
      { scope: "im:message:send_as_bot", level: 1 },
    ]);
    expect(getConnectorReadiness(process.env, NOW, undefined, {
      feishuPermission: {
        appId: "app",
        fingerprint: changedFingerprint,
        leastPrivilege: "no_excess_detected",
      },
    }).find((row) => row.key === "feishu")).toMatchObject({
      configurationReady: false,
      operational: false,
      securityReviewState: "unbound",
      expectedSecurityReviewBinding: feishuPermissionReviewEvidenceBinding(
        "app",
        changedFingerprint,
      ),
    });
    process.env.FEISHU_APP_ID = "replacement-app";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu")).toMatchObject({
      configurationReady: false,
      operational: false,
      liveVerificationState: "unbound",
      securityReviewState: "unbound",
    });
  });

  it("飞书双路径按实际优先路径绑定 UAT，webhook 证据不能替代应用机器人验收", () => {
    process.env.FEISHU_WEBHOOK_URL =
      "https://open.feishu.cn/open-apis/bot/v2/hook/test-connector";
    process.env.FEISHU_APP_ID = "app";
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.FEISHU_CHAT_ID = "chat";
    process.env.FEISHU_LIVE_VERIFIED_AT = "2026-07-29T01:00:00Z";
    process.env.FEISHU_LIVE_VERIFIED_REF = "UAT-20260729-FEISHU-GENERIC";
    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "2026-07-29T02:00:00Z";
    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_REF = "UAT-20260729-FEISHU-WEBHOOK";

    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({
        configuredAuthPaths: ["webhook", "app_bot"],
        activeAuthPath: "app_bot",
        configurationReady: false,
        operational: false,
        liveVerificationState: "missing",
        effectiveCapabilities: ["app-bot-message", "deduplicated-delivery"],
    });

    process.env.FEISHU_APP_LIVE_VERIFIED_AT = "2026-07-29T03:00:00Z";
    const boundRef = `UAT-20260729-${feishuTargetEvidenceBinding("app", "chat")}`;
    process.env.FEISHU_APP_LIVE_VERIFIED_REF = boundRef;
    process.env.FEISHU_APP_PERMISSION_REVIEWED_AT = "2026-07-29T03:00:00Z";
    process.env.FEISHU_APP_PERMISSION_REVIEWED_REF =
      `SEC-20260729-${feishuPermissionReviewEvidenceBinding(
        "app",
        FEISHU_PERMISSION_FINGERPRINT,
      )}`;
    expect(getConnectorReadiness(
      process.env,
      NOW,
      undefined,
      FEISHU_RUNTIME_EVIDENCE,
    ).find((row) => row.key === "feishu"))
      .toMatchObject({
        configurationReady: true,
        operational: true,
        liveVerificationState: "valid",
        liveVerificationRef: boundRef,
        securityReviewState: "valid",
      });
  });

  it("用友人工账号不构成机器配置；完整 OpenAPI 契约仍保持 contract_only", () => {
    for (const key of [
      "YY_APP_KEY", "YY_APP_SECRET", "YY_TENANT_ID", "YY_ORG_ID",
    ] as const) process.env[key] = "present";
    process.env.YY_PRODUCT_PROFILE = "yonsuite";
    process.env.YY_APPROVED_API_CONTRACTS = "supplier.read@v1,cost.read@v1";
    process.env.YY_ALLOWED_HOSTS = "api.yonyoucloud.com,auth.yonyoucloud.com";
    process.env.YY_BASE_URL = "https://api.yonyoucloud.com";
    process.env.YY_TOKEN_URL = "https://auth.yonyoucloud.com/token";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "yy")).toMatchObject({
      implementation: "contract_only",
      configured: true,
      operational: false,
      missingEnv: [],
    });
    expect(configuredConnectors().some((connector) => connector.key === "yy")).toBe(false);
    process.env.YY_TOKEN_URL = "http://auth.yonyoucloud.com/token";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "yy")).toMatchObject({
      configured: false,
      missingEnv: ["YY_TOKEN_URL"],
    });
  });

  it("live UAT 标记须有非秘密证据引用，且未来、非法或超过 90 天都不算 operational", () => {
    process.env.FEISHU_WEBHOOK_URL =
      "https://open.feishu.cn/open-apis/bot/v2/hook/test-connector";
    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_REF = "UAT-20260730-FEISHU-001";

    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "2026-08-01T00:00:00Z";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "future" });

    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "2026-04-01T00:00:00Z";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "stale" });

    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "not-a-date";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "invalid" });

    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "2026-07-30junk";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "invalid" });

    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "2026-02-30T01:00:00Z";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({ operational: false, liveVerificationState: "invalid" });

    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "2026-07-30T09:00:00+08:00";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({
        operational: true,
        liveVerificationState: "valid",
        liveVerifiedAt: "2026-07-30T01:00:00.000Z",
      });

    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_AT = "2026-07-30T01:00:00Z";
    process.env.FEISHU_WEBHOOK_LIVE_VERIFIED_REF = "https://tracker.example/UAT?id=secret";
    expect(getConnectorReadiness(process.env, NOW).find((row) => row.key === "feishu"))
      .toMatchObject({
        operational: false,
        liveVerificationState: "invalid",
        liveVerificationRef: null,
      });
  });
});
