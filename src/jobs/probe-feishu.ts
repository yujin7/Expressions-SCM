import {
  FeishuAppClient,
  feishuAppCredentialsFromEnv,
} from "@/server/integrations/feishu";

const NO_VISIBLE_CHAT_CHECKS = [
  "确认当前已发布版本包含机器人能力和 im:chat:readonly（或官方等价群信息权限）",
  "在目标群的机器人管理中确认加入的是本应用机器人，而不是只授予人员应用管理员权限",
  "确认目标群与应用属于同一租户，机器人未被移除且具有群内发言权限",
  "若刚发布或刚入群，等待配置生效后重新运行只读发现",
] as const;

/** Read-only discovery helper. It never sends a message or changes group membership. */
export async function probeFeishuChats(
  options: {
    env?: NodeJS.ProcessEnv;
    client?: Pick<FeishuAppClient, "listAccessibleChats">;
  } = {},
) {
  const credentials = feishuAppCredentialsFromEnv(options.env);
  if (!credentials) {
    return {
      status: "skipped" as const,
      reason: "缺少 FEISHU_APP_ID/FEISHU_APP_SECRET",
    };
  }
  const chats = await (
    options.client ?? new FeishuAppClient(credentials)
  ).listAccessibleChats();
  const discovery = chats.length > 0
    ? "ready_for_chat_selection" as const
    : "blocked_no_visible_chat" as const;
  return {
    status: "succeeded" as const,
    authentication: "validated" as const,
    discovery,
    chats: chats.length,
    items: chats,
    requiredChecks: chats.length === 0 ? [...NO_VISIBLE_CHAT_CHECKS] : [],
  };
}
