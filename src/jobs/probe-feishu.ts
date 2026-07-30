import {
  FeishuAppClient,
  feishuAppCredentialsFromEnv,
} from "@/server/integrations/feishu";

/** Read-only discovery helper. It never sends a message or changes group membership. */
export async function probeFeishuChats() {
  const credentials = feishuAppCredentialsFromEnv();
  if (!credentials) {
    return {
      status: "skipped" as const,
      reason: "缺少 FEISHU_APP_ID/FEISHU_APP_SECRET",
    };
  }
  const chats = await new FeishuAppClient(credentials).listAccessibleChats();
  return {
    status: "succeeded" as const,
    chats: chats.length,
    items: chats,
  };
}
