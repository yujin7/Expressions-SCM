import { describe, expect, it } from "vitest";
import { probeFeishuChats } from "@/jobs/probe-feishu";
import {
  feishuPermissionReviewEvidenceBinding,
  feishuPermissionSetFingerprint,
  feishuTargetEvidenceBinding,
} from "@/server/integrations/feishu";

const credentials = {
  NODE_ENV: "test",
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "secret_test",
} satisfies NodeJS.ProcessEnv;
const TARGET_CHAT_ID = "oc_test";
const TARGET_BINDING = feishuTargetEvidenceBinding(credentials.FEISHU_APP_ID, TARGET_CHAT_ID);
const PERMISSION_FINGERPRINT = feishuPermissionSetFingerprint([
  { scope: "application:application:self_manage", level: 1 },
  { scope: "im:chat:readonly", level: 1 },
  { scope: "im:message:send_as_bot", level: 1 },
]);
const PERMISSION_BINDING = feishuPermissionReviewEvidenceBinding(
  credentials.FEISHU_APP_ID,
  PERMISSION_FINGERPRINT,
);

const minimalApplication = {
  enabled: "enabled" as const,
  onlineVersion: "present" as const,
  botDefault: "bot_default_both" as const,
  scopes: {
    inventory: "parsed" as const,
    fingerprint: PERMISSION_FINGERPRINT,
    total: 3,
    elevated: 0,
    chatList: "declared" as const,
    sendAsBot: "declared" as const,
    outsideNotificationAllowlist: 0,
    leastPrivilege: "no_excess_detected" as const,
  },
};

describe("Feishu chat discovery probe", () => {
  it("reports missing credentials without calling the API", async () => {
    const result = await probeFeishuChats({ env: { NODE_ENV: "test" } });

    expect(result).toEqual({
      status: "skipped",
      reason: "缺少 FEISHU_APP_ID/FEISHU_APP_SECRET",
    });
  });

  it("separates declared permissions, exercised chat access, zero groups, and untested send", async () => {
    const result = await probeFeishuChats({
      env: credentials,
      client: {
        inspectSelfApplication: async () => minimalApplication,
        listAccessibleChats: async () => [],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      status: "succeeded",
      authentication: "validated",
      application: {
        inspection: "succeeded",
        enabled: "enabled",
        onlineVersion: "present",
        botDefault: "bot_default_both",
      },
      scopeInventory: {
        state: "parsed",
        fingerprint: PERMISSION_FINGERPRINT,
        totalDeclared: 3,
        elevatedDeclared: 0,
        outsideNotificationAllowlist: 0,
        leastPrivilege: "no_excess_detected",
      },
      chatList: { declared: "declared", exercise: "succeeded" },
      target: { configured: false, match: "not_configured" },
      send: {
        declared: "declared",
        liveUat: "not_validated",
        evidenceState: "missing",
        evidenceBinding: "target_not_configured",
        expectedEvidenceBinding: null,
      },
      evidenceReadiness: "pending_chat_or_uat",
      runtimeHealth: "not_tested_by_read_only_probe",
      discovery: "blocked_no_visible_chat",
      chats: 0,
      items: [],
    });
    expect(result.requiredChecks).toEqual(expect.arrayContaining([
      expect.stringContaining("本应用机器人"),
      expect.stringContaining("同一租户"),
      expect.stringContaining("缺少 FEISHU_CHAT_ID"),
      expect.stringContaining("真实目标群投递 UAT"),
    ]));
  });

  it("marks all bounded evidence ready without claiming live runtime health", async () => {
    const result = await probeFeishuChats({
      env: {
        ...credentials,
        FEISHU_CHAT_ID: TARGET_CHAT_ID,
        FEISHU_APP_LIVE_VERIFIED_AT: "2026-08-02T00:00:00Z",
        FEISHU_APP_LIVE_VERIFIED_REF: `UAT-20260802-${TARGET_BINDING}`,
        FEISHU_APP_PERMISSION_REVIEWED_AT: "2026-08-02T01:00:00Z",
        FEISHU_APP_PERMISSION_REVIEWED_REF: `SEC-20260802-${PERMISSION_BINDING}`,
      },
      client: {
        inspectSelfApplication: async () => minimalApplication,
        listAccessibleChats: async () => [{
          chatId: TARGET_CHAT_ID,
          name: "SCM UAT",
        }],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      status: "succeeded",
      target: { configured: true, match: "matched" },
      permissionReview: {
        evidenceState: "valid",
        evidenceBinding: "matched",
        expectedEvidenceBinding: PERMISSION_BINDING,
        reviewedAt: "2026-08-02T01:00:00.000Z",
      },
      send: {
        declared: "declared",
        liveUat: "validated_by_bound_evidence",
        evidenceState: "valid",
        evidenceBinding: "matched",
        expectedEvidenceBinding: TARGET_BINDING,
      },
      evidenceReadiness: "ready_by_evidence",
      runtimeHealth: "not_tested_by_read_only_probe",
      discovery: "ready_for_chat_selection",
      chats: 1,
      items: [{ chatId: TARGET_CHAT_ID, name: "SCM UAT" }],
      requiredChecks: [],
    });
  });

  it("blocks otherwise-ready app evidence until least-privilege review is app-bound", async () => {
    const result = await probeFeishuChats({
      env: {
        ...credentials,
        FEISHU_CHAT_ID: TARGET_CHAT_ID,
        FEISHU_APP_LIVE_VERIFIED_AT: "2026-08-02T00:00:00Z",
        FEISHU_APP_LIVE_VERIFIED_REF: `UAT-20260802-${TARGET_BINDING}`,
      },
      client: {
        inspectSelfApplication: async () => minimalApplication,
        listAccessibleChats: async () => [{ chatId: TARGET_CHAT_ID, name: "SCM UAT" }],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      send: { liveUat: "validated_by_bound_evidence" },
      permissionReview: {
        evidenceState: "missing",
        evidenceBinding: "evidence_not_valid",
        expectedEvidenceBinding: PERMISSION_BINDING,
      },
      evidenceReadiness: "blocked_permission_review",
    });
    expect(result.requiredChecks).toContain(
      "当前应用完成最小权限复核后，登记有效时间和绑定该应用及当前权限清单的非秘密复核编号",
    );
  });

  it("invalidates a still-fresh review when the same app permission set changes", async () => {
    const changedFingerprint = feishuPermissionSetFingerprint([
      { scope: "application:application:self_manage", level: 2 },
      { scope: "im:chat:readonly", level: 1 },
      { scope: "im:message:send_as_bot", level: 1 },
    ]);
    const result = await probeFeishuChats({
      env: {
        ...credentials,
        FEISHU_CHAT_ID: TARGET_CHAT_ID,
        FEISHU_APP_LIVE_VERIFIED_AT: "2026-08-02T00:00:00Z",
        FEISHU_APP_LIVE_VERIFIED_REF: `UAT-20260802-${TARGET_BINDING}`,
        FEISHU_APP_PERMISSION_REVIEWED_AT: "2026-08-02T01:00:00Z",
        FEISHU_APP_PERMISSION_REVIEWED_REF: `SEC-20260802-${PERMISSION_BINDING}`,
      },
      client: {
        inspectSelfApplication: async () => ({
          ...minimalApplication,
          scopes: {
            ...minimalApplication.scopes,
            fingerprint: changedFingerprint,
            elevated: 1,
          },
        }),
        listAccessibleChats: async () => [{ chatId: TARGET_CHAT_ID, name: "SCM UAT" }],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      permissionReview: {
        evidenceState: "valid",
        evidenceBinding: "unbound",
        expectedEvidenceBinding: feishuPermissionReviewEvidenceBinding(
          credentials.FEISHU_APP_ID,
          changedFingerprint,
        ),
      },
      evidenceReadiness: "blocked_permission_review",
    });
  });

  it("never becomes ready when a visible group exists but FEISHU_CHAT_ID is missing", async () => {
    const result = await probeFeishuChats({
      env: credentials,
      client: {
        inspectSelfApplication: async () => minimalApplication,
        listAccessibleChats: async () => [{ chatId: TARGET_CHAT_ID, name: "SCM UAT" }],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      target: { configured: false, match: "not_configured" },
      discovery: "ready_for_chat_selection",
      evidenceReadiness: "pending_chat_or_uat",
    });
    expect(result.requiredChecks).toContain(
      "缺少 FEISHU_CHAT_ID；从可见群中选择并配置唯一目标群后重新检查",
    );
  });

  it("never becomes ready when the configured target is not an exact visible-chat match", async () => {
    const configuredTarget = "oc_expected";
    const binding = feishuTargetEvidenceBinding(credentials.FEISHU_APP_ID, configuredTarget);
    const result = await probeFeishuChats({
      env: {
        ...credentials,
        FEISHU_CHAT_ID: configuredTarget,
        FEISHU_APP_LIVE_VERIFIED_AT: "2026-08-02T00:00:00Z",
        FEISHU_APP_LIVE_VERIFIED_REF: `UAT-20260802-${binding}`,
      },
      client: {
        inspectSelfApplication: async () => minimalApplication,
        listAccessibleChats: async () => [{ chatId: "oc_other", name: "Other" }],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      target: { configured: true, match: "not_visible" },
      send: {
        liveUat: "validated_by_bound_evidence",
        evidenceBinding: "matched",
      },
      evidenceReadiness: "pending_chat_or_uat",
    });
    expect(result.requiredChecks).toContain(
      "配置的 FEISHU_CHAT_ID 不在当前应用可见群中；核对租户、机器人入群状态和目标群配置",
    );
  });

  it("does not accept valid-but-unbound UAT evidence for the current app and target", async () => {
    const result = await probeFeishuChats({
      env: {
        ...credentials,
        FEISHU_CHAT_ID: TARGET_CHAT_ID,
        FEISHU_APP_LIVE_VERIFIED_AT: "2026-08-02T00:00:00Z",
        FEISHU_APP_LIVE_VERIFIED_REF: "UAT-20260802-FEISHU-APP",
      },
      client: {
        inspectSelfApplication: async () => minimalApplication,
        listAccessibleChats: async () => [{ chatId: TARGET_CHAT_ID, name: "SCM UAT" }],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      target: { configured: true, match: "matched" },
      send: {
        liveUat: "not_validated",
        evidenceState: "valid",
        evidenceBinding: "unbound",
        expectedEvidenceBinding: TARGET_BINDING,
      },
      evidenceReadiness: "pending_chat_or_uat",
    });
    expect(result.requiredChecks).toContain(
      "现有 UAT 证据未绑定当前应用和目标群；将探针给出的绑定标记写入非秘密证据编号后重验",
    );
  });

  it("blocks extreme over-privilege even when both required scopes are declared", async () => {
    const result = await probeFeishuChats({
      env: credentials,
      client: {
        inspectSelfApplication: async () => ({
          enabled: "enabled",
          onlineVersion: "present",
          botDefault: "bot_default_both",
          scopes: {
            inventory: "parsed",
            fingerprint: feishuPermissionSetFingerprint([{ scope: "many", level: 2 }]),
            total: 1_107,
            elevated: 1_007,
            chatList: "declared",
            sendAsBot: "declared",
            outsideNotificationAllowlist: 1_104,
            leastPrivilege: "extreme_over_privilege",
          },
        }),
        listAccessibleChats: async () => [],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      scopeInventory: {
        totalDeclared: 1_107,
        elevatedDeclared: 1_007,
        outsideNotificationAllowlist: 1_104,
        leastPrivilege: "extreme_over_privilege",
      },
      evidenceReadiness: "blocked_extreme_over_privilege",
    });
    expect(result.requiredChecks).toContain(
      "权限数量远超 SCM 通知最小集合；停止生产接入，改用专用最小权限应用并复核数据范围",
    );
    expect(JSON.stringify(result)).not.toContain("secret_test");
  });

  it("preserves unknown when the self-application response cannot prove version or scopes", async () => {
    const result = await probeFeishuChats({
      env: credentials,
      client: {
        inspectSelfApplication: async () => ({
          enabled: "unknown",
          onlineVersion: "unknown",
          botDefault: "unknown",
          scopes: {
            inventory: "ambiguous",
            fingerprint: null,
            total: 2,
            elevated: null,
            chatList: "unknown",
            sendAsBot: "unknown",
            outsideNotificationAllowlist: null,
            leastPrivilege: "unknown",
          },
        }),
        listAccessibleChats: async () => [],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      application: { onlineVersion: "unknown" },
      chatList: { declared: "unknown", exercise: "succeeded" },
      send: { declared: "unknown", liveUat: "not_validated" },
      evidenceReadiness: "blocked_unknown_permissions",
    });
    expect(result.requiredChecks).toEqual(expect.arrayContaining([
      expect.stringContaining("不得按已启用处理"),
      expect.stringContaining("不得按已发布处理"),
      expect.stringContaining("不得从调用成功反推声明状态"),
      expect.stringContaining("不得视为可发送"),
      expect.stringContaining("最小权限状态未知"),
    ]));
  });

  it("continues chat discovery when optional self-app inspection is unavailable", async () => {
    const result = await probeFeishuChats({
      env: credentials,
      client: {
        inspectSelfApplication: async () => {
          throw new Error("application:self_manage is intentionally absent");
        },
        listAccessibleChats: async () => [{ chatId: "oc_test", name: "SCM UAT" }],
      },
      now: new Date("2026-08-03T00:00:00Z"),
    });

    expect(result).toMatchObject({
      status: "succeeded",
      authentication: "validated",
      application: {
        inspection: "unavailable",
        enabled: "unknown",
        onlineVersion: "unknown",
        botDefault: "unknown",
      },
      scopeInventory: {
        state: "unavailable",
        totalDeclared: null,
        leastPrivilege: "unknown",
      },
      chatList: { declared: "unknown", exercise: "succeeded" },
      discovery: "ready_for_chat_selection",
      chats: 1,
      evidenceReadiness: "blocked_unknown_permissions",
    });
    expect(result.requiredChecks).toEqual(expect.arrayContaining([
      expect.stringContaining("无法只读获取本应用信息"),
      expect.stringContaining("不得从调用成功反推声明状态"),
    ]));
    expect(JSON.stringify(result)).not.toContain("application:self_manage");
  });
});
