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

  it("只读分页发现应用可见群，并去重排序", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("tenant_access_token")) {
        return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      }
      if (value.includes("page_token=next")) {
        return response({
          code: 0,
          data: {
            has_more: false,
            items: [
              { chat_id: "oc_a", name: "采购协同" },
              { chat_id: "oc_b", name: "供应链异常" },
            ],
          },
        });
      }
      return response({
        code: 0,
        data: {
          has_more: true,
          page_token: "next",
          items: [{ chat_id: "oc_b", name: "供应链异常" }],
        },
      });
    });
    const client = new FeishuAppClient(
      { appId: "cli_a", appSecret: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    await expect(client.listAccessibleChats()).resolves.toEqual([
      { chatId: "oc_a", name: "采购协同" },
      { chatId: "oc_b", name: "供应链异常" },
    ]);
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("tenant_access_token"))).toHaveLength(1);
  });

  it("未配置 chat_id 时拒绝发送，不会调用网络", async () => {
    const fetchMock = vi.fn();
    const client = new FeishuAppClient(
      { appId: "cli_a", appSecret: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 },
    );

    await expect(client.sendText({
      title: "异常",
      body: "数量变化",
      uuid: "notice-1",
    })).rejects.toThrow("未配置目标 chat_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
