import { describe, expect, it, vi } from "vitest";
import { FeishuAppClient } from "@/server/integrations/feishu";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("飞书应用机器人", () => {
  it("缓存 tenant token，并用 chat_id + UUID 发送可去重文本", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) {
        return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      return response({ code: 0, data: { message_id: "om_1" } });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const client = new FeishuAppClient({
      appId: "cli_a",
      appSecret: "secret",
      chatId: "oc_chat",
    }, { fetchImpl, retries: 0, now: () => 1_000_000 });

    await client.sendText({ title: "异常", body: "数量变化", uuid: "notice-1" });
    await client.sendText({ title: "异常", body: "数量变化", uuid: "notice-2" });

    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("tenant_access_token"));
    const messageCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/im/v1/messages"));
    expect(tokenCalls).toHaveLength(1);
    expect(messageCalls).toHaveLength(2);
    const [url, init] = messageCalls[0] as unknown as [string, RequestInit];
    expect(url).toContain("receive_id_type=chat_id");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tenant-token" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      receive_id: "oc_chat",
      msg_type: "text",
      uuid: "notice-1",
    });
    expect(String(init.body)).not.toContain("secret");
  });
});
