import { describe, expect, it, vi } from "vitest";
import { FeishuAppClient } from "@/server/integrations/feishu";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("飞书应用机器人：D61 按人私聊（union_id）", () => {
  it("receiveIdType=union_id 时 receive_id_type=union_id、receive_id=union_id；群发路径不变", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      return response({ code: 0, data: { message_id: "om_p" } });
    });
    const client = new FeishuAppClient({ appId: "cli_a", appSecret: "s", chatId: "oc_chat" }, { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 });

    await client.sendText({ title: "待办", body: "b", uuid: "u1", receiveIdType: "union_id", receiveId: "on_user" });
    await client.sendText({ title: "群", body: "b", uuid: "u2" });

    const messageCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/im/v1/messages"));
    expect(messageCalls).toHaveLength(2);
    const [url1, init1] = messageCalls[0] as unknown as [string, RequestInit];
    expect(url1).toContain("receive_id_type=union_id");
    expect(JSON.parse(String(init1.body))).toMatchObject({ receive_id: "on_user", msg_type: "text" });
    const [url2, init2] = messageCalls[1] as unknown as [string, RequestInit];
    expect(url2).toContain("receive_id_type=chat_id");
    expect(JSON.parse(String(init2.body))).toMatchObject({ receive_id: "oc_chat" });
  });

  it("union_id 缺失 → 抛错不发请求；群 chat_id 缺失亦然", async () => {
    const fetchMock = vi.fn();
    const client = new FeishuAppClient({ appId: "cli_a", appSecret: "s" }, { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 });
    await expect(client.sendText({ title: "t", body: "b", uuid: "u", receiveIdType: "union_id", receiveId: " " })).rejects.toThrow("union_id");
    await expect(client.sendText({ title: "t", body: "b", uuid: "u" })).rejects.toThrow("chat_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
