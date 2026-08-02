import {
  FeishuAppClient,
  feishuAppCredentialsFromEnv,
  feishuEvidenceRefHasPermissionReviewBinding,
  feishuEvidenceRefHasTargetBinding,
  feishuPermissionReviewEvidenceBinding,
  feishuTargetEvidenceBinding,
  type FeishuSelfApplicationInspection,
} from "@/server/integrations/feishu";
import {
  feishuAppLiveVerification,
  feishuAppPermissionReviewVerification,
} from "@/server/integrations/connector";

const NO_VISIBLE_CHAT_CHECKS = [
  "在目标群的机器人管理中确认加入的是本应用机器人，而不是只授予人员应用管理员权限",
  "确认目标群与应用属于同一租户，机器人未被移除且具有群内发言权限",
  "若刚发布或刚入群，等待配置生效后重新运行只读发现",
] as const;

const UNKNOWN_APPLICATION: FeishuSelfApplicationInspection = {
  enabled: "unknown",
  onlineVersion: "unknown",
  botDefault: "unknown",
  scopes: {
    inventory: "unavailable",
    total: null,
    elevated: null,
    chatList: "unknown",
    sendAsBot: "unknown",
    outsideNotificationAllowlist: null,
    leastPrivilege: "unknown",
  },
};

/** Read-only discovery helper. It never sends a message or changes group membership. */
export async function probeFeishuChats(
  options: {
    env?: NodeJS.ProcessEnv;
    client?: Pick<FeishuAppClient, "listAccessibleChats">
      & Partial<Pick<FeishuAppClient, "inspectSelfApplication">>;
    now?: Date;
  } = {},
) {
  const env = options.env ?? process.env;
  const credentials = feishuAppCredentialsFromEnv(env);
  if (!credentials) {
    return {
      status: "skipped" as const,
      reason: "缺少 FEISHU_APP_ID/FEISHU_APP_SECRET",
    };
  }
  const client = options.client ?? new FeishuAppClient(credentials);
  let application = UNKNOWN_APPLICATION;
  let applicationInspection: "succeeded" | "unavailable" = "unavailable";
  if (client.inspectSelfApplication) {
    try {
      application = await client.inspectSelfApplication();
      applicationInspection = "succeeded";
    } catch {
      // A dedicated notification app may intentionally lack application:self_manage. Keep the
      // evidence unknown and still exercise the independently authorized read-only chat endpoint.
    }
  }
  const chats = await client.listAccessibleChats();
  const liveUat = feishuAppLiveVerification(env, options.now);
  const permissionReview = feishuAppPermissionReviewVerification(env, options.now);
  const expectedPermissionReviewBinding = feishuPermissionReviewEvidenceBinding(credentials.appId);
  const permissionReviewBinding = permissionReview.state !== "valid"
    ? "evidence_not_valid" as const
    : feishuEvidenceRefHasPermissionReviewBinding(
        permissionReview.evidenceRef,
        credentials.appId,
      )
      ? "matched" as const
      : "unbound" as const;
  const boundPermissionReview = permissionReview.state === "valid"
    && permissionReviewBinding === "matched";
  const targetChatId = env.FEISHU_CHAT_ID?.trim() || null;
  const targetMatch = targetChatId === null
    ? "not_configured" as const
    : chats.some((chat) => chat.chatId === targetChatId)
      ? "matched" as const
      : "not_visible" as const;
  const expectedEvidenceBinding = targetChatId
    ? feishuTargetEvidenceBinding(credentials.appId, targetChatId)
    : null;
  const evidenceBinding = targetChatId === null
    ? "target_not_configured" as const
    : liveUat.state !== "valid"
      ? "evidence_not_valid" as const
      : feishuEvidenceRefHasTargetBinding(
          liveUat.evidenceRef,
          credentials.appId,
          targetChatId,
        )
        ? "matched" as const
        : "unbound" as const;
  const boundLiveUat = liveUat.state === "valid" && evidenceBinding === "matched";
  const discovery = chats.length > 0
    ? "ready_for_chat_selection" as const
    : "blocked_no_visible_chat" as const;
  const requiredChecks: string[] = [];
  if (applicationInspection === "unavailable") {
    requiredChecks.push("无法只读获取本应用信息；发布状态、机器人默认能力和权限声明均保持未知");
  }
  if (application.enabled === "not_enabled") {
    requiredChecks.push("应用状态不是启用；启用应用后重新检查");
  } else if (application.enabled === "unknown") {
    requiredChecks.push("应用启用状态未知；不得按已启用处理");
  }
  if (application.onlineVersion === "absent") {
    requiredChecks.push("当前没有线上版本；发布包含机器人能力和所需权限的版本后重新检查");
  } else if (application.onlineVersion === "unknown") {
    requiredChecks.push("应用信息响应未能明确判断线上版本；人工核对发布状态，不得按已发布处理");
  }
  if (application.botDefault === "not_bot_default") {
    requiredChecks.push("移动端和 PC 端均无机器人默认能力证据；人工核对机器人能力与已发布版本");
  } else if (application.botDefault === "bot_default_partial") {
    requiredChecks.push("仅部分客户端显示机器人默认能力；核对两端已发布能力是否一致");
  } else if (application.botDefault === "unknown") {
    requiredChecks.push("机器人默认能力证据未知；不得仅凭权限声明认定机器人可用");
  }
  if (application.scopes.chatList === "not_declared") {
    requiredChecks.push("权限清单未声明 im:chat:readonly；核对权限版本与只读群目录调用口径");
  } else if (application.scopes.chatList === "unknown") {
    requiredChecks.push("权限清单结构不明确；人工核对 im:chat:readonly，不得从调用成功反推声明状态");
  }
  if (chats.length === 0) requiredChecks.push(...NO_VISIBLE_CHAT_CHECKS);
  if (targetMatch === "not_configured") {
    requiredChecks.push("缺少 FEISHU_CHAT_ID；从可见群中选择并配置唯一目标群后重新检查");
  } else if (targetMatch === "not_visible") {
    requiredChecks.push("配置的 FEISHU_CHAT_ID 不在当前应用可见群中；核对租户、机器人入群状态和目标群配置");
  }
  if (application.scopes.sendAsBot === "not_declared") {
    requiredChecks.push("申请并发布 im:message:send_as_bot 后再做真实群投递 UAT");
  } else if (application.scopes.sendAsBot === "unknown") {
    requiredChecks.push("权限清单结构不明确；人工核对 im:message:send_as_bot，不得视为可发送");
  }
  if (liveUat.state !== "valid") {
    requiredChecks.push("只读探针不会发消息；真实目标群投递 UAT 通过后登记有效时间与非秘密证据编号");
  } else if (!boundLiveUat) {
    requiredChecks.push("现有 UAT 证据未绑定当前应用和目标群；将探针给出的绑定标记写入非秘密证据编号后重验");
  }
  if (application.scopes.leastPrivilege === "extreme_over_privilege") {
    requiredChecks.push("权限数量远超 SCM 通知最小集合；停止生产接入，改用专用最小权限应用并复核数据范围");
  } else if (application.scopes.leastPrivilege === "review_required") {
    requiredChecks.push("存在 SCM 通知白名单外权限；完成逐项最小权限审查前不得按生产安全处理");
  } else if (application.scopes.leastPrivilege === "unknown") {
    requiredChecks.push("无法可靠解析权限清单；最小权限状态未知，须人工复核");
  }
  if (permissionReview.state !== "valid") {
    requiredChecks.push("当前应用完成最小权限复核后，登记有效时间和绑定该应用的非秘密复核编号");
  } else if (!boundPermissionReview) {
    requiredChecks.push("现有最小权限复核证据未绑定当前应用；将探针给出的复核绑定标记写入非秘密证据编号后重验");
  }
  const transportEvidenceReady = application.enabled === "enabled"
    && application.onlineVersion === "present"
    && application.botDefault === "bot_default_both"
    && application.scopes.chatList === "declared"
    && application.scopes.sendAsBot === "declared"
    && targetMatch === "matched"
    && boundLiveUat;
  const evidenceReady = transportEvidenceReady && boundPermissionReview;
  const evidenceReadiness = application.scopes.leastPrivilege === "extreme_over_privilege"
    ? "blocked_extreme_over_privilege" as const
    : application.scopes.leastPrivilege === "review_required"
      ? "blocked_scope_review" as const
      : application.scopes.leastPrivilege === "unknown"
        ? "blocked_unknown_permissions" as const
        : transportEvidenceReady && !boundPermissionReview
          ? "blocked_permission_review" as const
          : evidenceReady
            ? "ready_by_evidence" as const
            : "pending_chat_or_uat" as const;
  return {
    status: "succeeded" as const,
    authentication: "validated" as const,
    application: {
      inspection: applicationInspection,
      enabled: application.enabled,
      onlineVersion: application.onlineVersion,
      botDefault: application.botDefault,
    },
    scopeInventory: {
      state: application.scopes.inventory,
      totalDeclared: application.scopes.total,
      elevatedDeclared: application.scopes.elevated,
      outsideNotificationAllowlist: application.scopes.outsideNotificationAllowlist,
      leastPrivilege: application.scopes.leastPrivilege,
    },
    permissionReview: {
      evidenceState: permissionReview.state,
      evidenceBinding: permissionReviewBinding,
      expectedEvidenceBinding: expectedPermissionReviewBinding,
      reviewedAt: permissionReview.verifiedAt,
      evidenceRef: permissionReview.evidenceRef,
    },
    chatList: {
      declared: application.scopes.chatList,
      exercise: "succeeded" as const,
    },
    target: {
      configured: targetChatId !== null,
      match: targetMatch,
    },
    send: {
      declared: application.scopes.sendAsBot,
      liveUat: boundLiveUat
        ? "validated_by_bound_evidence" as const
        : "not_validated" as const,
      evidenceState: liveUat.state,
      evidenceBinding,
      expectedEvidenceBinding,
    },
    evidenceReadiness,
    runtimeHealth: "not_tested_by_read_only_probe" as const,
    discovery,
    chats: chats.length,
    items: chats,
    requiredChecks,
  };
}
