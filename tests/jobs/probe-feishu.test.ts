import { describe, expect, it } from "vitest";
import { probeFeishuChats } from "@/jobs/probe-feishu";

const credentials = {
  NODE_ENV: "test",
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "secret_test",
} satisfies NodeJS.ProcessEnv;

describe("Feishu chat discovery probe", () => {
  it("reports missing credentials without calling the API", async () => {
    const result = await probeFeishuChats({ env: { NODE_ENV: "test" } });

    expect(result).toEqual({
      status: "skipped",
      reason: "缺少 FEISHU_APP_ID/FEISHU_APP_SECRET",
    });
  });

  it("distinguishes valid authentication from zero visible groups", async () => {
    const result = await probeFeishuChats({
      env: credentials,
      client: { listAccessibleChats: async () => [] },
    });

    expect(result).toMatchObject({
      status: "succeeded",
      authentication: "validated",
      discovery: "blocked_no_visible_chat",
      chats: 0,
      items: [],
    });
    expect(result.requiredChecks).toEqual(expect.arrayContaining([
      expect.stringContaining("im:chat:readonly"),
      expect.stringContaining("应用管理员权限"),
      expect.stringContaining("同一租户"),
    ]));
  });

  it("marks a visible group ready for explicit target selection", async () => {
    const result = await probeFeishuChats({
      env: credentials,
      client: {
        listAccessibleChats: async () => [{
          chatId: "oc_test",
          name: "SCM UAT",
        }],
      },
    });

    expect(result).toEqual({
      status: "succeeded",
      authentication: "validated",
      discovery: "ready_for_chat_selection",
      chats: 1,
      items: [{ chatId: "oc_test", name: "SCM UAT" }],
      requiredChecks: [],
    });
  });
});
